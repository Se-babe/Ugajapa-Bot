import { Request, Response } from "express";
import { query } from "./db";
import { synthesizeSpeech, isGoogleTTSEnabled } from "./google_tts";
import { segmentsToSrt } from "./groq_whisper";
import { detectLanguage, isSupportedLanguage, normalizeTranslationCode } from "./languages";
import { routeTranslate } from "./router";
import { transcribeAudioBuffer } from "./stt";
import { evaluateTranslationQuality } from "./quality_eval";
import { countCharacters, getPlanLimit } from "./usage";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_DOC_CHARS = 100_000;
const CHUNK_SIZE = 900;

type MediaTranslateBody = {
  translated: string;
  from: string;
  to: string;
  engine: string;
  score: number;
  semantic_score: number;
  quality_score: number;
};

async function getMonthlyUsage(userId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
       AND timestamp < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [userId]
  );
  return parseInt(result.rows[0].total, 10);
}

async function checkQuota(
  req: Request,
  res: Response,
  characters: number
): Promise<boolean> {
  if (!req.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const limit = getPlanLimit(req.apiKey.plan);
  const used = await getMonthlyUsage(req.apiKey.userId);
  if (used + characters > limit) {
    res.status(429).json({
      error: "Monthly quota exceeded",
      used,
      limit,
      plan: req.apiKey.plan,
      upgrade_url: "https://api.ugajapa.ac.ug/upgrade",
    });
    return false;
  }
  return true;
}

async function recordUsage(
  req: Request,
  transcript: string,
  from: string,
  to: string,
  engine: string,
  qualityScore: number
): Promise<void> {
  if (!req.apiKey) return;
  const characters = countCharacters(transcript);
  await query(
    `INSERT INTO usage_records
       (api_key_id, user_id, characters, from_lang, to_lang, engine, quality_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      req.apiKey.keyId,
      req.apiKey.userId,
      characters,
      from,
      to,
      engine,
      qualityScore,
    ]
  );
}

async function translateTranscript(
  transcript: string,
  to: string,
  from?: string
): Promise<MediaTranslateBody> {
  const toNorm = normalizeTranslationCode(to);
  const sourceLang = normalizeTranslationCode(
    from?.trim() || (await detectLanguage(transcript)).language
  );

  const result = await routeTranslate(transcript, sourceLang, toNorm);

  let reversed = transcript;
  if (process.env.BACK_TRANSLATION_ENABLED === "true" && sourceLang !== toNorm && result.engine !== "none") {
    const back = await routeTranslate(result.translated, toNorm, sourceLang);
    reversed = back.translated;
  }

  const quality = await evaluateTranslationQuality(
    transcript,
    result.translated,
    sourceLang,
    toNorm,
    reversed
  );

  return {
    translated: result.translated,
    from: sourceLang,
    to: toNorm,
    engine: result.engine,
    score: quality.score,
    semantic_score: quality.semantic_score,
    quality_score: quality.overall,
  };
}

export async function transcribeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file?.buffer?.length) {
    res.status(400).json({ error: "audio file is required" });
    return;
  }

  if (file.size > MAX_MEDIA_BYTES) {
    res.status(400).json({
      error: `File too large (${Math.round(file.size / 1024 / 1024)} MB). Max 25 MB.`,
    });
    return;
  }

  const languageHint = String(
    req.body?.language_hint || req.body?.language || ""
  ).trim();
  const mimeType = String(req.body?.mime_type || file.mimetype || "").trim();
  const rawCandidates = String(req.body?.language_candidates || "").trim();
  const languageCandidates = rawCandidates
    ? rawCandidates.split(/[,;]+/).map((c) => c.trim()).filter(Boolean)
    : [];

  try {
    const result = await transcribeAudioBuffer(file.buffer, file.originalname || "audio.webm", {
      languageHint: languageHint || undefined,
      mimeType: mimeType || undefined,
      languageCandidates,
    });

    // Bill on transcript length when an API key is present.
    if (req.apiKey) {
      const chars = countCharacters(result.text);
      const ok = await checkQuota(req, res, chars);
      if (!ok) return;
      await recordUsage(
        req,
        result.text,
        result.detected_language || "unknown",
        "stt",
        result.engine,
        1.0
      );
    }

    res.json({
      text: result.text,
      detected_language: result.detected_language,
      engine: result.engine,
    });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Transcription failed",
    });
  }
}

export async function synthesizeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const text = String(req.body?.text || "").trim();
  const language = String(
    req.body?.language || req.body?.lang || ""
  ).trim();
  const voiceGender = String(
    req.body?.voice_gender || req.body?.gender || ""
  ).trim();

  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (!language) {
    res.status(400).json({ error: "language is required" });
    return;
  }
  if (!isGoogleTTSEnabled()) {
    res.status(502).json({
      error: "Google Text-to-Speech is not configured (set GOOGLE_API_KEY)",
    });
    return;
  }

  if (req.apiKey) {
    const ok = await checkQuota(req, res, countCharacters(text));
    if (!ok) return;
  }

  try {
    const audio = await synthesizeSpeech(text, language, voiceGender);
    if (req.apiKey) {
      await recordUsage(req, text, language, "tts", "google-tts", 1.0);
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("Synthesis error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Speech synthesis failed",
    });
  }
}

export async function audioTranslateHandler(
  req: Request,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file?.buffer?.length) {
    res.status(400).json({
      error: "file is required (multipart/form-data field: file)",
    });
    return;
  }

  const audioOk =
    file.mimetype.startsWith("audio/") ||
    file.mimetype === "video/webm" ||
    file.mimetype === "application/octet-stream";
  if (!audioOk) {
    res.status(400).json({
      error: `Unsupported type: ${file.mimetype}. Expected an audio file.`,
    });
    return;
  }

  const to = String(req.body?.to || "").trim();
  const from = String(req.body?.from || "").trim() || undefined;
  if (!to) {
    res.status(400).json({ error: "to (target language) is required" });
    return;
  }
  if (!(await isSupportedLanguage(to))) {
    res.status(400).json({
      error: `Unsupported target language: ${to}`,
      hint: "Call GET /languages for the full global language list",
    });
    return;
  }
  if (from && !(await isSupportedLanguage(from))) {
    res.status(400).json({
      error: `Unsupported source language: ${from}`,
      hint: "Call GET /languages for the full global language list",
    });
    return;
  }

  try {
    const stt = await transcribeAudioBuffer(
      file.buffer,
      file.originalname || "audio.webm",
      { languageHint: from, mimeType: file.mimetype }
    );

    const transcript = stt.text.trim();
    if (!transcript) {
      res.status(422).json({ error: "No speech detected in the audio file" });
      return;
    }

    const sourceLang = from || stt.detected_language;
    if (req.apiKey) {
      const ok = await checkQuota(req, res, countCharacters(transcript));
      if (!ok) return;
    }

    const translation = await translateTranscript(transcript, to, sourceLang);
    if (req.apiKey) {
      await recordUsage(
        req,
        transcript,
        translation.from,
        to,
        translation.engine,
        translation.score
      );
    }

    res.json({
      origin: transcript,
      transcript,
      translated: translation.translated,
      from: translation.from,
      to,
      engine: "ugajapa-bot",
      score: translation.score,
      semantic_score: translation.semantic_score,
      quality_score: translation.quality_score,
      srt: "",
    });
  } catch (err) {
    console.error("Audio translation error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Audio translation failed",
    });
  }
}

export async function videoTranslateHandler(
  req: Request,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file?.buffer?.length) {
    res.status(400).json({
      error: "file is required (multipart/form-data field: file)",
    });
    return;
  }

  const videoOk =
    file.mimetype.startsWith("video/") ||
    file.mimetype.startsWith("audio/") ||
    file.mimetype === "application/octet-stream";
  if (!videoOk) {
    res.status(400).json({
      error: `Unsupported type: ${file.mimetype}. Expected a video file.`,
    });
    return;
  }

  const to = String(req.body?.to || "").trim();
  const from = String(req.body?.from || "").trim() || undefined;
  if (!to) {
    res.status(400).json({ error: "to (target language) is required" });
    return;
  }
  if (!(await isSupportedLanguage(to))) {
    res.status(400).json({
      error: `Unsupported target language: ${to}`,
      hint: "Call GET /languages for the full global language list",
    });
    return;
  }
  if (from && !(await isSupportedLanguage(from))) {
    res.status(400).json({
      error: `Unsupported source language: ${from}`,
      hint: "Call GET /languages for the full global language list",
    });
    return;
  }

  try {
    const stt = await transcribeAudioBuffer(
      file.buffer,
      file.originalname || "video.webm",
      {
        languageHint: from,
        mimeType: file.mimetype,
        verbose: true,
      }
    );

    const transcript = stt.text.trim();
    if (!transcript) {
      res.status(422).json({ error: "No speech detected in the video file" });
      return;
    }

    const sourceLang = from || stt.detected_language;
    if (req.apiKey) {
      const ok = await checkQuota(req, res, countCharacters(transcript));
      if (!ok) return;
    }

    const translation = await translateTranscript(transcript, to, sourceLang);
    if (req.apiKey) {
      await recordUsage(
        req,
        transcript,
        translation.from,
        to,
        translation.engine,
        translation.score
      );
    }

    let srt = "";
    if (stt.segments?.length) {
      const translatedSegments = await Promise.all(
        stt.segments.map(async (seg) => {
          try {
            const t = await routeTranslate(seg.text.trim(), sourceLang, to);
            return { ...seg, text: t.translated };
          } catch {
            return seg;
          }
        })
      );
      srt = segmentsToSrt(translatedSegments);
    }

    res.json({
      origin: transcript,
      transcript,
      translated: translation.translated,
      from: translation.from,
      to,
      engine: "ugajapa-bot",
      score: translation.score,
      semantic_score: translation.semantic_score,
      quality_score: translation.quality_score,
      srt,
    });
  } catch (err) {
    console.error("Video translation error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Video translation failed",
    });
  }
}

async function extractDocumentText(
  buffer: Buffer,
  mimetype: string,
  filename: string
): Promise<{ text: string; pageCount?: number }> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const isPdf =
    mimetype === "application/pdf" ||
    (mimetype === "application/octet-stream" && ext === "pdf");
  const isDocx =
    mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    (mimetype === "application/octet-stream" && ext === "docx");
  const isTxt =
    mimetype.startsWith("text/") ||
    (mimetype === "application/octet-stream" &&
      ["txt", "md", "csv", "log"].includes(ext));

  if (isPdf) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const data = await parser.getText();
    return { text: data.text, pageCount: data.total };
  }
  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }
  if (isTxt) {
    return { text: buffer.toString("utf8") };
  }

  throw new Error(
    `Unsupported document type: ${mimetype || ext || "unknown"}. ` +
      "Supported formats: PDF (.pdf), Word (.docx), plain text (.txt, .md, .csv)"
  );
}

function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length <= CHUNK_SIZE) {
      chunks.push(trimmed);
    } else {
      const sentences = trimmed.split(/(?<=[.!?।])\s+/);
      let current = "";
      for (const sentence of sentences) {
        if (current && current.length + sentence.length + 1 > CHUNK_SIZE) {
          chunks.push(current);
          current = sentence;
        } else {
          current = current ? current + " " + sentence : sentence;
        }
      }
      if (current) chunks.push(current);
    }
  }

  return chunks;
}

export async function documentTranslateHandler(
  req: Request,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file?.buffer?.length) {
    res.status(400).json({
      error: "file is required (multipart/form-data field: file)",
    });
    return;
  }

  const to = String(req.body?.to || "").trim();
  const from = String(req.body?.from || "").trim() || undefined;
  if (!to) {
    res.status(400).json({ error: "to (target language) is required" });
    return;
  }
  if (!(await isSupportedLanguage(to))) {
    res.status(400).json({
      error: `Unsupported target language: ${to}`,
      hint: "Call GET /languages for the full list",
    });
    return;
  }
  if (from && !(await isSupportedLanguage(from))) {
    res.status(400).json({
      error: `Unsupported source language: ${from}`,
      hint: "Call GET /languages for the full list",
    });
    return;
  }

  let extracted: { text: string; pageCount?: number };
  try {
    extracted = await extractDocumentText(
      file.buffer,
      file.mimetype,
      file.originalname || "document"
    );
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to extract document text",
    });
    return;
  }

  const rawText = extracted.text.trim();
  if (!rawText) {
    res.status(422).json({ error: "No text content found in the document" });
    return;
  }
  if (rawText.length > MAX_DOC_CHARS) {
    res.status(413).json({
      error: `Document too long (${rawText.length} characters). Maximum is ${MAX_DOC_CHARS}.`,
    });
    return;
  }

  if (req.apiKey) {
    const ok = await checkQuota(req, res, countCharacters(rawText));
    if (!ok) return;
  }

  const sourceLang = normalizeTranslationCode(
    from?.trim() || (await detectLanguage(rawText)).language
  );
  const targetLang = normalizeTranslationCode(to);

  const chunks = chunkText(rawText);
  const translatedChunks: string[] = [];
  let lastEngine = "ugajapa-bot";

  try {
    for (const chunk of chunks) {
      const result = await routeTranslate(chunk, sourceLang, targetLang);
      translatedChunks.push(result.translated);
      lastEngine = result.engine;
    }
  } catch (err) {
    console.error("Document translation error:", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Translation failed",
    });
    return;
  }

  const translatedText = translatedChunks.join("\n\n");

  if (req.apiKey) {
    await recordUsage(req, rawText, sourceLang, to, lastEngine, 1.0);
  }

  res.json({
    filename: file.originalname || "document",
    page_count: extracted.pageCount,
    char_count: rawText.length,
    chunk_count: chunks.length,
    from: sourceLang,
    to: targetLang,
    engine: lastEngine,
    origin: rawText,
    translated: translatedText,
  });
}
