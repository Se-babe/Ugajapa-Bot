import {
  isGoogleSpeechEnabled,
  transcribeWithGoogleSpeech,
} from "./google_speech";
import {
  isGroqWhisperEnabled,
  transcribeWithGroq,
  WhisperSegment,
} from "./groq_whisper";
import { detectLanguage } from "./languages";
import { normalizeSpeechLanguageCode } from "./speech_bcp47";

const UGANDAN_LANGS = new Set(["lg", "ach", "nyn", "teo"]);

export type TranscriptionResult = {
  text: string;
  detected_language: string;
  engine: string;
  segments?: WhisperSegment[];
};

export function getSpeechEngine(): string {
  const parts: string[] = [];
  if (isGoogleSpeechEnabled()) parts.push("google-speech");
  if (isGroqWhisperEnabled()) parts.push("groq-whisper");
  return parts.length ? parts.join("+") : "none";
}

function prefersGroq(languageHint?: string, candidates?: string[]): boolean {
  const hint = normalizeSpeechLanguageCode(languageHint);
  if (hint && UGANDAN_LANGS.has(hint)) return true;
  if (candidates?.some((c) => UGANDAN_LANGS.has(normalizeSpeechLanguageCode(c)))) {
    return true;
  }
  return false;
}

function scoreResult(
  result: TranscriptionResult,
  preferredLang?: string
): number {
  let score = result.text.trim().length;
  if (result.engine.includes("google")) score += 12;
  if (result.engine.includes("groq")) score += 8;
  if (
    preferredLang &&
    normalizeSpeechLanguageCode(result.detected_language) ===
      normalizeSpeechLanguageCode(preferredLang)
  ) {
    score += 20;
  }
  return score;
}

function pickBest(
  results: TranscriptionResult[],
  preferredLang?: string
): TranscriptionResult {
  const usable = results.filter((r) => r.text.trim().length > 0);
  if (!usable.length) {
    throw new Error("No speech detected in the recording");
  }
  usable.sort(
    (a, b) => scoreResult(b, preferredLang) - scoreResult(a, preferredLang)
  );
  return usable[0];
}

async function finalizeLanguage(
  text: string,
  fallback: string
): Promise<string> {
  const detected = await detectLanguage(text);
  const fromDetect = normalizeSpeechLanguageCode(detected.language);
  if (fromDetect) return fromDetect;
  return normalizeSpeechLanguageCode(fallback);
}

/**
 * Route STT by language (per spec):
 * - Ugandan languages → Groq Whisper primary, Google fallback
 * - EN/JA and others → Google Speech primary, Groq Whisper fallback
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  fileName: string,
  options?: {
    languageHint?: string;
    mimeType?: string;
    languageCandidates?: string[];
    verbose?: boolean;
  }
): Promise<TranscriptionResult> {
  const languageHint = options?.languageHint?.trim() || "";
  const languageCandidates = (options?.languageCandidates || [])
    .map((c) => c.trim())
    .filter(Boolean);
  const mimeType = options?.mimeType || "";
  const useGroqFirst = prefersGroq(languageHint, languageCandidates);

  const results: TranscriptionResult[] = [];
  const groqOpts = {
    languageHint: languageHint || undefined,
    mimeType: mimeType || undefined,
    verbose: options?.verbose,
  };
  const googleOpts = {
    mimeType: mimeType || undefined,
    languageHint: languageHint || undefined,
    languageCandidates,
  };

  if (useGroqFirst) {
    if (isGroqWhisperEnabled()) {
      try {
        results.push(await transcribeWithGroq(buffer, fileName, groqOpts));
      } catch (err) {
        console.warn("Groq Whisper failed:", err);
      }
    }
    if (isGoogleSpeechEnabled()) {
      try {
        results.push(
          await transcribeWithGoogleSpeech(buffer, fileName, googleOpts)
        );
      } catch (err) {
        console.warn("Google Speech failed:", err);
      }
    }
  } else {
    if (isGoogleSpeechEnabled()) {
      try {
        results.push(
          await transcribeWithGoogleSpeech(buffer, fileName, googleOpts)
        );
      } catch (err) {
        console.warn("Google Speech failed:", err);
      }
    }
    if (isGroqWhisperEnabled()) {
      try {
        results.push(await transcribeWithGroq(buffer, fileName, groqOpts));
      } catch (err) {
        console.warn("Groq Whisper failed:", err);
      }
    }
  }

  if (!results.length) {
    throw new Error(
      "Speech-to-text unavailable — configure GROQ_API_KEY and/or GOOGLE_API_KEY"
    );
  }

  const preferred =
    languageHint ||
    languageCandidates[0] ||
    results.find((r) => r.detected_language)?.detected_language ||
    "";
  const best = results.length === 1 ? results[0] : pickBest(results, preferred);
  const detected = await finalizeLanguage(best.text, best.detected_language);

  return {
    text: best.text,
    detected_language: detected || best.detected_language,
    engine: best.engine,
    segments: best.segments,
  };
}
