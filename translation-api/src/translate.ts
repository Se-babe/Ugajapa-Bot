import { Request, Response } from "express";
import { query } from "./db";
import {
  detectLanguage,
  getLanguagesResponse,
  isSupportedLanguage,
  normalizeTranslationCode,
} from "./languages";
import { evaluateTranslationQuality } from "./quality_eval";
import { routeTranslate } from "./router";
import { countCharacters, getPlanLimit } from "./usage";

const BACK_TRANSLATION_ENABLED =
  process.env.BACK_TRANSLATION_ENABLED === "true";

export type { QualityResult } from "./quality_eval";

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

  const { text, from: fromInput, to } = req.body as {
    text?: string;
    from?: string;
    to?: string;
  };

  if (!text || !to) {
    res.status(400).json({ error: "text and to are required" });
    return;
  }

  // A missing/empty "from" means the caller wants source-language auto-detection.
  let from = fromInput?.trim() || "";
  let detectedFrom: string | undefined;
  if (!from) {
    const detected = await detectLanguage(text);
    detectedFrom = detected.language;
    from = detected.language;
  }

  const toNorm = normalizeTranslationCode(to);
  const fromNorm = normalizeTranslationCode(from);

  if (!(await isSupportedLanguage(toNorm))) {
    res.status(400).json({
      error: `Unsupported target language: ${to}`,
      hint: "Call GET /languages for the full global language list",
    });
    return;
  }

  if (fromNorm && !(await isSupportedLanguage(fromNorm))) {
    res.status(400).json({
      error: `Unsupported source language: ${from}`,
      hint: "Call GET /languages for the full global language list",
    });
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
    const result = await routeTranslate(text, fromNorm || from, toNorm);

    // Back-translation is optional — disabled by default to avoid doubling engine calls.
    let reversed = text;
    if (
      BACK_TRANSLATION_ENABLED &&
      fromNorm !== toNorm &&
      result.engine !== "none"
    ) {
      const back = await routeTranslate(result.translated, toNorm, fromNorm || from);
      reversed = back.translated;
    }

    const quality = await evaluateTranslationQuality(
      text,
      result.translated,
      fromNorm || from,
      toNorm,
      reversed
    );

    await query(
      `INSERT INTO usage_records
         (api_key_id, user_id, characters, from_lang, to_lang, engine, quality_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.apiKey.keyId,
        req.apiKey.userId,
        characters,
        fromNorm || from,
        toNorm,
        result.engine,
        quality.overall,
      ]
    );

    res.json({
      origin: text,
      translated: result.translated,
      reversed,
      from: fromNorm || from,
      to: toNorm,
      detected_from: detectedFrom ?? null,
      // The actual routing engine (Groq/Google/bot) is an internal
      // implementation detail — recorded in usage_records for analytics,
      // but never exposed to clients. Every response is branded as the bot.
      engine: "ugajapa-bot",
      quality,
      score: quality.score,
      semantic_score: quality.semantic_score,
      embedding_score: quality.semantic_score,
      quality_score: quality.overall,
      review_passed: quality.passed,
      review_reason: quality.review_reason,
      cached: result.cached === true,
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

export async function detectHandler(req: Request, res: Response): Promise<void> {
  const { text } = req.body as { text?: string };
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const { language, confidence } = await detectLanguage(text);
  res.json({ language, confidence, text: text.trim() });
}

export async function languagesHandler(
  _req: Request,
  res: Response
): Promise<void> {
  res.json(await getLanguagesResponse());
}

/** JWT-authenticated playground translate (uses user's latest active API key). */
export async function dashboardTranslateHandler(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const keyResult = await query<{ id: string; name: string }>(
    `SELECT id, name FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  const key = keyResult.rows[0];
  if (!key) {
    res.status(400).json({
      error: "Generate an API key first to use the translation playground",
    });
    return;
  }

  req.apiKey = {
    keyId: key.id,
    userId: req.user.id,
    plan: req.user.plan,
    name: key.name,
  };

  return translateHandler(req, res);
}
