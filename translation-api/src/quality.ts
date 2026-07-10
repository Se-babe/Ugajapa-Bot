/** Rule-based quality evaluation (ported from TranslationAccuracyService + back-translation signals). */

export type QualityLabel = "High" | "Good" | "Fair" | "Low";

export type QualityEvaluation = {
  score: number;
  label: QualityLabel;
  signals: string[];
  levenshtein: number;
  semantic: number;
};

const TARGET_SCRIPT: Partial<Record<string, RegExp>> = {
  bn: /[\u0980-\u09ff]/,
  hi: /[\u0900-\u097f]/,
  ja: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9faf]/,
  ko: /[\uac00-\ud7af]/,
  zh: /[\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff]/,
  th: /[\u0e00-\u0e7f]/,
  ru: /[\u0400-\u04ff]/,
  lg: /[\u0041-\u005a\u0061-\u007a]/,
  sw: /[\u0041-\u005a\u0061-\u007a]/,
};

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function levenshteinScore(original: string, reversed: string): number {
  const a = original.toLowerCase().trim();
  const b = reversed.toLowerCase().trim();
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Number((1 - dist / maxLen).toFixed(3));
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

function semanticScore(original: string, reversed: string): number {
  const a = tokenize(original);
  const b = tokenize(reversed);
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

function labelFor(score: number): QualityLabel {
  if (score >= 85) return "High";
  if (score >= 68) return "Good";
  if (score >= 45) return "Fair";
  return "Low";
}

function providerBaseline(engine: string): number {
  if (engine.includes("dictionary")) return 94;
  if (engine.includes("google")) return 84;
  if (engine.includes("sunbird")) return 80;
  if (engine.includes("ugajapa-bot")) return 76;
  return 58;
}

/**
 * Combined rule-based + back-translation quality evaluation.
 * Returns 0–100 score with diagnostic signals for every translation.
 */
export function evaluateTranslationQuality(
  original: string,
  translated: string,
  sourceLang: string,
  targetLang: string,
  reversed: string,
  engine: string
): QualityEvaluation {
  const src = original.trim();
  const tr = translated.trim();
  const rev = reversed.trim();
  const signals: string[] = [];

  if (!tr) {
    return {
      score: 0,
      label: "Low",
      signals: ["empty_translation"],
      levenshtein: 0,
      semantic: 0,
    };
  }

  const lev = levenshteinScore(src, rev || tr);
  const sem = semanticScore(src, rev || tr);

  let score = providerBaseline(engine);

  if (sourceLang !== targetLang && normalize(src) === normalize(tr)) {
    score -= 35;
    signals.push("unchanged_text");
  }

  const ratio = tr.length / Math.max(src.length, 1);
  if (ratio < 0.15 || ratio > 4.5) {
    score -= 22;
    signals.push("length_ratio_bad");
  } else if (ratio >= 0.4 && ratio <= 2.5) {
    score += 4;
    signals.push("length_ratio_ok");
  }

  const script = TARGET_SCRIPT[targetLang.split(/[-_]/)[0]];
  if (script && !script.test(tr) && sourceLang !== targetLang) {
    score -= 18;
    signals.push("target_script_mismatch");
  } else if (script && script.test(tr)) {
    signals.push("target_script_match");
  }

  if (sourceLang === targetLang) {
    score = Math.min(score, 72);
    signals.push("same_language_pair");
  }

  if (/etymology|derived from|ハンガリー|hungarian/i.test(tr)) {
    score -= 40;
    signals.push("etymology_dump");
  }

  // Blend back-translation similarity into final score
  const backTranslationScore = Math.round(((lev + sem) / 2) * 100);
  score = Math.round(score * 0.55 + backTranslationScore * 0.45);

  if (lev >= 0.7) signals.push("backtranslation_strong");
  else if (lev >= 0.4) signals.push("backtranslation_moderate");
  else signals.push("backtranslation_weak");

  const rounded = Math.max(0, Math.min(100, score));

  return {
    score: rounded,
    label: labelFor(rounded),
    signals,
    levenshtein: lev,
    semantic: sem,
  };
}

/** Plugin-compatible 0–1 quality score from evaluation. */
export function qualityScoreNormalized(evaluation: QualityEvaluation): number {
  return Number((evaluation.score / 100).toFixed(3));
}
