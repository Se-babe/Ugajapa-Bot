import { Request, Response } from "express";
import { botLanguages } from "./ugajapa-bot";
import {
  checkQuota,
  deliverTranslation,
  evaluateTranslation,
  fullTranslation,
  recordUsage,
  toPluginResponse,
  toV1Response,
  type TranslateInput,
} from "./translate-core";

async function handleTranslate(
  req: Request,
  res: Response,
  mode: "full" | "deliver" | "evaluate" | "v1"
): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as TranslateInput;

  try {
    if (mode !== "evaluate") {
      const text = body.text?.trim() || body.origin?.trim();
      if (text) {
        const characters = [...text].length;
        const quota = await checkQuota(
          req.apiKey.userId,
          req.apiKey.plan,
          characters
        );
        if (!quota.ok) {
          res.status(429).json({
            error: "Monthly quota exceeded",
            used: quota.used,
            limit: quota.limit,
            plan: req.apiKey.plan,
            upgrade_url: "https://api.ugajapa.ac.ug/upgrade",
          });
          return;
        }
      }
    }

    let output;
    let meterCharacters = 0;

    if (mode === "deliver") {
      output = await deliverTranslation(body);
      meterCharacters = output.characters;
    } else if (mode === "evaluate") {
      output = await evaluateTranslation(body);
      meterCharacters = 0;
      await recordUsage(req.apiKey.keyId, req.apiKey.userId, {
        ...output,
        characters: 0,
      });
    } else if (body.fast) {
      output = await fullTranslation({ ...body, fast: true });
      meterCharacters = output.characters;
    } else {
      output = await fullTranslation(body);
      meterCharacters = output.characters;
    }

    if (meterCharacters > 0) {
      await recordUsage(req.apiKey.keyId, req.apiKey.userId, output);
    }

    if (mode === "v1") {
      res.json(toV1Response(output));
      return;
    }

    res.json(toPluginResponse(output));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("required") ||
      message.includes("must be")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("Translation error:", err);
    res.status(502).json({
      error: "Translation engine unavailable",
      detail: message,
    });
  }
}

export async function translateHandler(req: Request, res: Response): Promise<void> {
  await handleTranslate(req, res, "full");
}

export async function deliverHandler(req: Request, res: Response): Promise<void> {
  await handleTranslate(req, res, "deliver");
}

export async function evaluateHandler(req: Request, res: Response): Promise<void> {
  await handleTranslate(req, res, "evaluate");
}

export async function v1TranslateHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as TranslateInput & {
    sourceLang?: string;
    targetLang?: string;
    text?: string;
  };

  const normalized: TranslateInput = {
    text: body.text,
    from: body.from || body.sourceLang,
    to: body.to || body.targetLang,
    fast: body.fast,
    hint_language: body.hint_language,
  };

  if (!normalized.text || !normalized.from || !normalized.to) {
    res.status(400).json({
      error: "text, from/sourceLang, and to/targetLang are required",
    });
    return;
  }

  req.body = normalized;
  await handleTranslate(req, res, "v1");
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
  const names: Record<string, string> = {
    en: "English",
    ja: "Japanese",
    lg: "Luganda",
    fr: "French",
    sw: "Swahili",
    ach: "Acholi",
    nyn: "Runyankole",
    teo: "Ateso",
  };

  res.json({
    languages: langs.map((code) => ({
      code,
      name: names[code] || code,
    })),
  });
}

export async function v1LanguagesHandler(
  req: Request,
  res: Response
): Promise<void> {
  await languagesHandler(req, res);
}
