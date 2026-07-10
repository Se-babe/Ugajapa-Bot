import crypto from "crypto";
import { query } from "./db";
import { routeTranslate, googleFallback } from "./router";
import { countCharacters, getPlanLimit } from "./usage";
import {
  evaluateTranslationQuality,
  qualityScoreNormalized,
  type QualityEvaluation,
} from "./quality";

export type TranslateInput = {
  text?: string;
  from?: string;
  to?: string;
  hint_language?: string;
  fast?: boolean;
  origin?: string;
  translated?: string;
  detected_from?: string;
  engine?: string;
};

export type TranslateOutput = {
  requestId: string;
  origin: string;
  translated: string;
  reversed: string;
  from: string;
  to: string;
  detectedFrom: string;
  engine: string;
  characters: number;
  quality: QualityEvaluation;
  score: number;
  semantic_score: number;
  embedding_score: number;
  quality_score: number;
};

export function createRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeLang(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

function isSameLanguage(a: string, b: string): boolean {
  return normalizeLang(a) === normalizeLang(b);
}

async function detectLanguage(text: string): Promise<string> {
  const sample = text.trim();
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(sample)) return "ja";
  if (/\b(wasuze|otyano|bulungi|webale|ssente|omuntu|nno)\b/i.test(sample)) return "lg";
  if (/\b(bonjour|merci|aujourd|français|oui|non)\b/i.test(sample)) return "fr";
  if (/\b(habari|asante|karibu|jambo|sana)\b/i.test(sample)) return "sw";
  return "en";
}

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

export async function checkQuota(
  userId: string,
  plan: string,
  characters: number
): Promise<{ ok: true } | { ok: false; used: number; limit: number }> {
  const limit = getPlanLimit(plan);
  const used = await getMonthlyUsage(userId);
  if (used + characters > limit) {
    return { ok: false, used, limit };
  }
  return { ok: true };
}

function buildOutput(
  requestId: string,
  origin: string,
  translated: string,
  reversed: string,
  from: string,
  to: string,
  detectedFrom: string,
  engine: string,
  characters: number,
  quality: QualityEvaluation
): TranslateOutput {
  const quality_score = qualityScoreNormalized(quality);
  return {
    requestId,
    origin,
    translated,
    reversed,
    from,
    to,
    detectedFrom,
    engine,
    characters,
    quality,
    score: quality.levenshtein,
    semantic_score: quality.semantic,
    embedding_score: 0,
    quality_score,
  };
}

async function backTranslate(
  translated: string,
  from: string,
  to: string
): Promise<string> {
  if (isSameLanguage(from, to)) return translated;
  const back = await routeTranslate(translated, to, from);
  return back.translated;
}

/** Forward translation only — instant delivery for Mattermost plugin. */
export async function deliverTranslation(input: TranslateInput): Promise<TranslateOutput> {
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");
  if (!input.to) throw new Error("to is required");

  const requestId = createRequestId();
  const origin = input.origin?.trim() || text;
  let from = input.from?.trim() || "";
  const to = input.to;

  if (!from) {
    from = await detectLanguage(text);
  }

  if (isSameLanguage(from, to)) {
    return buildOutput(
      requestId,
      origin,
      text,
      "",
      from,
      to,
      from,
      "none",
      countCharacters(text),
      {
        score: 0,
        label: "Fair",
        signals: ["same_language_pair"],
        levenshtein: 0,
        semantic: 0,
      }
    );
  }

  const result = await routeTranslate(text, from, to);
  const detectedFrom = input.detected_from?.trim() || from;

  return buildOutput(
    requestId,
    origin,
    result.translated,
    "",
    detectedFrom,
    to,
    detectedFrom,
    `${result.engine}:deliver`,
    countCharacters(text),
    {
      score: 0,
      label: "Fair",
      signals: ["deliver_only"],
      levenshtein: 0,
      semantic: 0,
    }
  );
}

/** Quality evaluation on an existing translation pair. */
export async function evaluateTranslation(input: TranslateInput): Promise<TranslateOutput> {
  const origin = input.origin?.trim();
  const translated = input.translated?.trim();
  if (!origin || !translated) throw new Error("origin and translated are required");
  if (!input.to) throw new Error("to is required");

  const requestId = createRequestId();
  const to = input.to;
  let from = input.from?.trim() || input.detected_from?.trim() || "";
  const detectedFrom = input.detected_from?.trim() || from;
  const engine = (input.engine || "ugajapa-bot").replace(/:deliver$/, "");

  if (!from) {
    from = await detectLanguage(origin);
  }

  const reversed = await backTranslate(translated, from, to);
  const quality = evaluateTranslationQuality(
    origin,
    translated,
    from,
    to,
    reversed,
    engine
  );

  return buildOutput(
    requestId,
    origin,
    translated,
    reversed,
    from,
    to,
    detectedFrom || from,
    `${engine}:evaluate`,
    countCharacters(origin),
    quality
  );
}

/** Fast path: one forward + lightweight back-translation score. */
export async function fastTranslation(input: TranslateInput): Promise<TranslateOutput> {
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");
  if (!input.to) throw new Error("to is required");

  const requestId = createRequestId();
  const origin = input.origin?.trim() || text;
  let from = input.from?.trim() || "";
  const to = input.to;

  if (!from) {
    from = await detectLanguage(text);
  }

  if (isSameLanguage(from, to)) {
    const quality = evaluateTranslationQuality(origin, text, from, to, text, "none");
    return buildOutput(
      requestId,
      origin,
      text,
      text,
      from,
      to,
      from,
      "none",
      countCharacters(text),
      quality
    );
  }

  const result = await routeTranslate(text, from, to);
  const detectedFrom = from;

  if (input.from?.trim()) {
    const quality = evaluateTranslationQuality(
      origin,
      result.translated,
      detectedFrom,
      to,
      result.translated,
      `${result.engine}:fast`
    );
    return buildOutput(
      requestId,
      origin,
      result.translated,
      result.translated,
      detectedFrom,
      to,
      detectedFrom,
      `${result.engine}:fast`,
      countCharacters(text),
      quality
    );
  }

  const reversed = await backTranslate(result.translated, detectedFrom, to);
  const quality = evaluateTranslationQuality(
    origin,
    result.translated,
    detectedFrom,
    to,
    reversed,
    `${result.engine}:fast`
  );

  return buildOutput(
    requestId,
    origin,
    result.translated,
    reversed,
    detectedFrom,
    to,
    detectedFrom,
    `${result.engine}:fast`,
    countCharacters(text),
    quality
  );
}

/** Full translation with quality scoring and optional Google fallback. */
export async function fullTranslation(input: TranslateInput): Promise<TranslateOutput> {
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");
  if (!input.to) throw new Error("to is required");

  if (input.fast) {
    return fastTranslation(input);
  }

  const requestId = createRequestId();
  const origin = input.origin?.trim() || text;
  let from = input.from?.trim() || "";
  const to = input.to;

  if (!from) {
    from = await detectLanguage(text);
  }

  if (isSameLanguage(from, to)) {
    const quality = evaluateTranslationQuality(origin, text, from, to, text, "none");
    return buildOutput(
      requestId,
      origin,
      text,
      text,
      from,
      to,
      from,
      "none",
      countCharacters(text),
      quality
    );
  }

  let result = await routeTranslate(text, from, to);
  let reversed = await backTranslate(result.translated, from, to);
  let quality = evaluateTranslationQuality(
    origin,
    result.translated,
    from,
    to,
    reversed,
    result.engine
  );

  if (
    quality.label === "Low" &&
    ((from === "en" && to === "ja") || (from === "ja" && to === "en"))
  ) {
    const fallback = await googleFallback(text, from, to);
    if (fallback) {
      const fbReversed = await backTranslate(fallback.translated, from, to);
      const fbQuality = evaluateTranslationQuality(
        origin,
        fallback.translated,
        from,
        to,
        fbReversed,
        fallback.engine
      );
      if (fbQuality.score >= quality.score) {
        result = fallback;
        reversed = fbReversed;
        quality = fbQuality;
      }
    }
  }

  return buildOutput(
    requestId,
    origin,
    result.translated,
    reversed,
    from,
    to,
    from,
    result.engine,
    countCharacters(text),
    quality
  );
}

export async function recordUsage(
  apiKeyId: string,
  userId: string,
  output: TranslateOutput
): Promise<void> {
  await query(
    `INSERT INTO usage_records
       (api_key_id, user_id, characters, from_lang, to_lang, engine, quality_score, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      apiKeyId,
      userId,
      output.characters,
      output.from,
      output.to,
      output.engine,
      output.quality_score,
      output.requestId,
    ]
  );
}

export function toV1Response(output: TranslateOutput) {
  return {
    translation: output.translated,
    sourceLang: output.from,
    targetLang: output.to,
    engine: output.engine.replace(/:(deliver|evaluate|fast)$/, ""),
    usage: {
      sourceCharacters: output.characters,
      billedCharacters: output.characters,
    },
    quality: {
      score: output.quality.score,
      label: output.quality.label,
      signals: output.quality.signals,
    },
    requestId: output.requestId,
  };
}

export function toPluginResponse(output: TranslateOutput) {
  return {
    origin: output.origin,
    translated: output.translated,
    reversed: output.reversed,
    from: output.from,
    to: output.to,
    detected_from: output.detectedFrom,
    engine: output.engine,
    score: output.score,
    semantic_score: output.semantic_score,
    embedding_score: output.embedding_score,
    quality_score: output.quality_score,
    requestId: output.requestId,
    characters_used: output.characters,
    quality: {
      score: output.quality.score,
      label: output.quality.label,
      signals: output.quality.signals,
      levenshtein: output.quality.levenshtein,
      semantic: output.quality.semantic,
    },
  };
}
