import { botTranslate, BotTranslateResult } from "./ugajapa-bot";

const SUNBIRD_API_URL = process.env.SUNBIRD_API_URL || "https://api.sunbird.ai/translate";
const SUNBIRD_API_KEY = process.env.SUNBIRD_API_KEY || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

export type RouteResult = {
  translated: string;
  engine: string;
};

async function sunbirdTranslate(
  text: string,
  from: string,
  to: string
): Promise<string> {
  if (!SUNBIRD_API_KEY) {
    throw new Error("SUNBIRD_API_KEY not configured");
  }

  const res = await fetch(SUNBIRD_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUNBIRD_API_KEY}`,
    },
    body: JSON.stringify({
      source_language: from,
      target_language: to,
      text,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Sunbird AI error ${res.status}`);
  }

  const data = (await res.json()) as {
    translated_text?: string;
    translation?: string;
    text?: string;
  };
  return data.translated_text || data.translation || data.text || "";
}

async function googleTranslate(
  text: string,
  from: string,
  to: string
): Promise<string> {
  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY not configured");
  }

  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", GOOGLE_API_KEY);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: from, target: to, format: "text" }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Google Translate error ${res.status}`);
  }

  const data = (await res.json()) as {
    data: { translations: { translatedText: string }[] };
  };
  return data.data.translations[0].translatedText;
}

function isLugandaPair(from: string, to: string): boolean {
  return from === "lg" || to === "lg";
}

/**
 * Route translation to the correct engine based on language pair.
 * Change only this file to swap/add engines.
 */
export async function routeTranslate(
  text: string,
  from: string,
  to: string
): Promise<RouteResult> {
  if (from === to) {
    return { translated: text, engine: "none" };
  }

  // English ↔ Luganda → Sunbird primary, UgaJapa Bot fallback
  if ((from === "en" && to === "lg") || (from === "lg" && to === "en")) {
    try {
      const translated = await sunbirdTranslate(text, from, to);
      return { translated, engine: "sunbird" };
    } catch {
      const result = await botTranslate(text, from, to);
      return { translated: result.translated, engine: "ugajapa-bot-fallback" };
    }
  }

  // Japanese ↔ Luganda → English pivot via UgaJapa Bot
  if ((from === "ja" && to === "lg") || (from === "lg" && to === "ja")) {
    try {
      // Prefer Sunbird for lg↔en leg when available
      if (from === "lg") {
        let enText: string;
        let enginePrefix: string;
        try {
          enText = await sunbirdTranslate(text, "lg", "en");
          enginePrefix = "sunbird";
        } catch {
          const mid = await botTranslate(text, "lg", "en");
          enText = mid.translated;
          enginePrefix = "ugajapa-bot";
        }
        const ja = await botTranslate(enText, "en", "ja");
        return {
          translated: ja.translated,
          engine: `${enginePrefix}+ugajapa-bot`,
        };
      }
      // ja → lg
      const en = await botTranslate(text, "ja", "en");
      try {
        const lg = await sunbirdTranslate(en.translated, "en", "lg");
        return { translated: lg, engine: "ugajapa-bot+sunbird" };
      } catch {
        const lg = await botTranslate(en.translated, "en", "lg");
        return { translated: lg.translated, engine: "ugajapa-bot" };
      }
    } catch (err) {
      const direct = await botTranslate(text, from, to);
      return { translated: direct.translated, engine: "ugajapa-bot" };
    }
  }

  // Luganda involved with other langs → Sunbird pivot via EN when possible
  if (isLugandaPair(from, to) && from !== "en" && to !== "en") {
    try {
      const toEn = await sunbirdTranslate(text, from, "en");
      const result = await botTranslate(toEn, "en", to);
      return { translated: result.translated, engine: "sunbird+ugajapa-bot" };
    } catch {
      const result = await botTranslate(text, from, to);
      return { translated: result.translated, engine: "ugajapa-bot-fallback" };
    }
  }

  // English ↔ Acholi → UgaJapa Bot primary, Sunbird fallback
  if ((from === "en" && to === "ach") || (from === "ach" && to === "en")) {
    try {
      const result = await botTranslate(text, from, to);
      return { translated: result.translated, engine: "ugajapa-bot" };
    } catch {
      try {
        const translated = await sunbirdTranslate(text, from, to);
        return { translated, engine: "sunbird" };
      } catch (err) {
        throw err;
      }
    }
  }

  // Default: UgaJapa Bot (EN↔JA, FR, SW, etc.)
  const result: BotTranslateResult = await botTranslate(text, from, to);
  return { translated: result.translated, engine: "ugajapa-bot" };
}

/**
 * Optional Google fallback when confidence is low for EN↔JA (and other pairs).
 */
export async function googleFallback(
  text: string,
  from: string,
  to: string
): Promise<RouteResult | null> {
  if (!GOOGLE_API_KEY) return null;
  try {
    const translated = await googleTranslate(text, from, to);
    return { translated, engine: "google-fallback" };
  } catch {
    return null;
  }
}
