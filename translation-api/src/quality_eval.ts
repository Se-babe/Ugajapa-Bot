import { languageDisplayName } from "./languages";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL =
  process.env.GROQ_QUALITY_MODEL || "llama-3.3-70b-versatile";
const PASS_THRESHOLD = parseFloat(
  process.env.QUALITY_PASS_THRESHOLD || "0.7"
);

export type QualityResult = {
  score: number;
  semantic_score: number;
  overall: number;
  label: "Good" | "Fair" | "Low";
  color: "green" | "amber" | "red";
  passed: boolean;
  review_reason: string | null;
  method: "ai" | "heuristic";
};

export function isAiQualityEnabled(): boolean {
  return (
    GROQ_API_KEY.length > 0 && process.env.QUALITY_EVAL_DISABLED !== "true"
  );
}

function qualityLabel(
  score: number,
  passed: boolean
): Pick<QualityResult, "label" | "color"> {
  if (passed && score >= PASS_THRESHOLD) {
    return { label: "Good", color: "green" };
  }
  if (score >= 0.4) return { label: "Fair", color: "amber" };
  return { label: "Low", color: "red" };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** Word-overlap F1 — fallback when AI evaluation is unavailable. */
function heuristicSemanticScore(original: string, reference: string): number {
  const a = tokenize(original);
  const b = tokenize(reference);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap++;
  }
  const precision = overlap / b.size;
  const recall = overlap / a.size;
  if (precision + recall === 0) return 0;
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(3));
}

type AiEvalPayload = {
  score?: number;
  passed?: boolean;
  reason?: string | null;
};

function parseAiEvalJson(raw: string): AiEvalPayload {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("AI quality response did not contain JSON");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as AiEvalPayload;
}

async function aiEvaluate(
  original: string,
  translated: string,
  from: string,
  to: string
): Promise<{ score: number; passed: boolean; reason: string | null }> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not configured");
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You evaluate translation quality. Compare the SOURCE text with its TRANSLATION " +
            "and decide whether the meaning, intent, and important details are clearly preserved. " +
            "Ignore minor stylistic differences. Focus on semantic equivalence, not word-for-word match. " +
            "Respond ONLY with JSON: " +
            '{"score": <0.0-1.0>, "passed": <boolean>, "reason": <string or null>}. ' +
            "Set passed to true when meaning is clearly preserved. " +
            "When passed is false, reason MUST briefly explain what is missing, wrong, or unclear.",
        },
        {
          role: "user",
          content: JSON.stringify({
            source_language: languageDisplayName(from),
            target_language: languageDisplayName(to),
            source_text: original,
            translation: translated,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    throw new Error(`Groq quality API error ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Groq quality API returned an empty response");
  }

  const parsed = parseAiEvalJson(content);
  const score = Math.max(0, Math.min(1, Number(parsed.score)));
  if (!Number.isFinite(score)) {
    throw new Error("AI quality response missing a valid score");
  }

  const passed =
    typeof parsed.passed === "boolean"
      ? parsed.passed
      : score >= PASS_THRESHOLD;
  const reason =
    !passed && parsed.reason?.trim()
      ? parsed.reason.trim()
      : !passed
        ? "The translation may not fully preserve the meaning of the source text."
        : null;

  return { score: Number(score.toFixed(3)), passed, reason };
}

/**
 * Evaluate whether a translation preserves the meaning of the source text.
 * Uses AI semantic review when Groq is configured; otherwise falls back to
 * word-overlap on a back-translation reference (no Levenshtein distance).
 */
export async function evaluateTranslationQuality(
  original: string,
  translated: string,
  from: string,
  to: string,
  backTranslation?: string
): Promise<QualityResult> {
  if (isAiQualityEnabled()) {
    try {
      const ai = await aiEvaluate(original, translated, from, to);
      const { label, color } = qualityLabel(ai.score, ai.passed);
      return {
        score: ai.score,
        semantic_score: ai.score,
        overall: ai.score,
        label,
        color,
        passed: ai.passed,
        review_reason: ai.reason,
        method: "ai",
      };
    } catch (err) {
      console.warn("[quality] AI evaluation failed, using heuristic:", err);
    }
  }

  const reference = backTranslation?.trim() || translated;
  const score = heuristicSemanticScore(original, reference);
  const passed = score >= PASS_THRESHOLD;
  const { label, color } = qualityLabel(score, passed);

  return {
    score,
    semantic_score: score,
    overall: score,
    label,
    color,
    passed,
    review_reason: passed
      ? null
      : "Meaning overlap with the source text appears low. Configure AI evaluation (GROQ_API_KEY) for a detailed review reason.",
    method: "heuristic",
  };
}
