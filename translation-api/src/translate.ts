import { Request, Response } from "express";
import { query } from "./db";
import { routeTranslate, googleFallback } from "./router";
import { botLanguages } from "./ugajapa-bot";
import { countCharacters, getPlanLimit } from "./usage";

export type QualityResult = {
  levenshtein: number;
  semantic: number;
  label: "Good" | "Fair" | "Low";
  color: "green" | "amber" | "red";
};

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

/** Word-overlap F1 as a lightweight semantic similarity proxy. */
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

function qualityLabel(score: number): Pick<QualityResult, "label" | "color"> {
  if (score >= 0.7) return { label: "Good", color: "green" };
  if (score >= 0.4) return { label: "Fair", color: "amber" };
  return { label: "Low", color: "red" };
}

export function scoreQuality(original: string, reversed: string): QualityResult {
  const lev = levenshteinScore(original, reversed);
  const sem = semanticScore(original, reversed);
  const combined = (lev + sem) / 2;
  const { label, color } = qualityLabel(combined);
  return { levenshtein: lev, semantic: sem, label, color };
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

export async function translateHandler(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { text, from, to } = req.body as {
    text?: string;
    from?: string;
    to?: string;
  };

  if (!text || !from || !to) {
    res.status(400).json({ error: "text, from, and to are required" });
    return;
  }

  const characters = countCharacters(text);
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
    return;
  }

  try {
    let result = await routeTranslate(text, from, to);

    // Back-translation for quality scoring
    let reversed = text;
    if (from !== to && result.engine !== "none") {
      const back = await routeTranslate(result.translated, to, from);
      reversed = back.translated;
    }

    let quality = scoreQuality(text, reversed);

    // Optional Google fallback for low confidence on EN↔JA (and similar)
    if (
      quality.label === "Low" &&
      ((from === "en" && to === "ja") || (from === "ja" && to === "en"))
    ) {
      const fallback = await googleFallback(text, from, to);
      if (fallback) {
        const back = await routeTranslate(fallback.translated, to, from);
        const q2 = scoreQuality(text, back.translated);
        if (q2.levenshtein >= quality.levenshtein) {
          result = fallback;
          reversed = back.translated;
          quality = q2;
        }
      }
    }

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
        result.engine,
        quality.levenshtein,
      ]
    );

    res.json({
      origin: text,
      translated: result.translated,
      reversed,
      from,
      to,
      engine: result.engine,
      quality,
      characters_used: characters,
      cultural_hint: null,
    });
  } catch (err) {
    console.error("Translation error:", err);
    res.status(502).json({
      error: "Translation engine unavailable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Simple heuristic language detection. */
export async function detectHandler(req: Request, res: Response): Promise<void> {
  const { text } = req.body as { text?: string };
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const sample = text.trim();
  let language = "en";
  let confidence = 0.5;

  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(sample)) {
    language = "ja";
    confidence = 0.9;
  } else if (
    /\b(wasuze|otyano|bulungi|webale|ssente|omuntu|nno)\b/i.test(sample)
  ) {
    language = "lg";
    confidence = 0.75;
  } else if (/\b(bonjour|merci|aujourd|français|oui|non)\b/i.test(sample)) {
    language = "fr";
    confidence = 0.7;
  } else if (/\b(habari|asante|karibu|jambo|sana)\b/i.test(sample)) {
    language = "sw";
    confidence = 0.7;
  } else if (/^[A-Za-z0-9\s.,!?'"-]+$/.test(sample)) {
    language = "en";
    confidence = 0.65;
  }

  res.json({ language, confidence, text: sample });
}

export async function languagesHandler(
  _req: Request,
  res: Response
): Promise<void> {
  const langs = await botLanguages();
  res.json({
    languages: langs.map((code) => ({
      code,
      name:
        (
          {
            en: "English",
            ja: "Japanese",
            lg: "Luganda",
            fr: "French",
            sw: "Swahili",
            ach: "Acholi",
            nyn: "Runyankole",
            teo: "Ateso",
          } as Record<string, string>
        )[code] || code,
    })),
  });
}
