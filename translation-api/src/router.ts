import {
  languageDisplayName,
  normalizeTranslationCode,
} from "./languages";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "./translation_cache";
import { botTranslate, BotTranslateResult } from "./ugajapa-bot";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

const UGANDAN_LANGS = new Set(["lg", "ach", "nyn", "teo"]);

export type RouteResult = {
  translated: string;
  engine: string;
  cached?: boolean;
};

async function groqTranslate(
  text: string,
  from: string,
  to: string
): Promise<string> {
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
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are a translation engine. Translate the user's message from ${languageDisplayName(from)} ` +
            `to ${languageDisplayName(to)}. Reply with ONLY the translated text — no explanations, ` +
            `no quotation marks, no notes.`,
        },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const translated = data.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error("Groq API returned an empty translation");
  }
  return translated;
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

  const body: Record<string, string> = {
    q: text,
    target: to,
    format: "text",
  };
  if (from) body.source = from;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Translate error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    data: { translations: { translatedText: string }[] };
  };
  return data.data.translations[0].translatedText;
}

function isPassthrough(source: string, translated: string): boolean {
  const s = source.trim().toLowerCase().replace(/\s+/g, " ");
  const t = translated.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === t) return true;
  // Levenshtein ratio > 0.92 means barely changed — treat as no-op
  const longer = Math.max(s.length, t.length);
  if (longer === 0) return false;
  let same = 0;
  const minLen = Math.min(s.length, t.length);
  for (let i = 0; i < minLen; i++) if (s[i] === t[i]) same++;
  return same / longer > 0.92;
}

async function botFallback(
  text: string,
  from: string,
  to: string
): Promise<RouteResult> {
  const result: BotTranslateResult = await botTranslate(text, from, to);
  if (isPassthrough(text, result.translated)) {
    throw new Error(`ugajapa-bot produced no translation for ${from}→${to}`);
  }
  return { translated: result.translated, engine: "ugajapa-bot-fallback" };
}

type EngineStep = {
  name: string;
  run: () => Promise<RouteResult>;
};

/**
 * Three-tier engine ordering — change only this function to reorder/add
 * engines. Ugandan languages and Japanese get Groq first, since it's
 * meaningfully better on those than Google (Google is generally faster and
 * fine everywhere else, so it leads for the rest). ugajapa-bot (NLLB-200)
 * is always the last resort, on every tier.
 */
function engineChain(
  text: string,
  from: string,
  to: string
): EngineStep[] {
  const chain: EngineStep[] = [];
  const ugandan = UGANDAN_LANGS.has(from) || UGANDAN_LANGS.has(to);
  const japanese = from === "ja" || to === "ja";
  const groqFirst = ugandan || japanese;

  const googleStep: EngineStep = {
    name: "google",
    run: async () => ({
      translated: await googleTranslate(text, from, to),
      engine: "google",
    }),
  };
  const groqStep: EngineStep = {
    name: "groq",
    run: async () => ({
      translated: await groqTranslate(text, from, to),
      engine: "groq",
    }),
  };

  if (groqFirst) {
    if (GROQ_API_KEY) chain.push(groqStep);
    if (GOOGLE_API_KEY) chain.push(googleStep);
  } else {
    if (GOOGLE_API_KEY) chain.push(googleStep);
    if (GROQ_API_KEY) chain.push(groqStep);
  }

  // ugajapa-bot (NLLB-200) as last resort, every tier.
  chain.push({
    name: "ugajapa-bot",
    run: () => botFallback(text, from, to),
  });

  return chain;
}

/**
 * Universal translation routing — every language pair uses the full engine
 * chain so regional (Ugandan/Japanese) and world languages all work.
 */
async function translateUncached(
  text: string,
  from: string,
  to: string
): Promise<RouteResult> {
  const src = normalizeTranslationCode(from);
  const tgt = normalizeTranslationCode(to);
  const chain = engineChain(text, src, tgt);

  let lastError: Error | undefined;
  for (const step of chain) {
    try {
      return await step.run();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Engine ${step.name} failed for ${src}->${tgt}:`, lastError.message);
    }
  }

  throw lastError || new Error("All translation engines failed");
}

export async function routeTranslate(
  text: string,
  from: string,
  to: string
): Promise<RouteResult> {
  const src = normalizeTranslationCode(from);
  const tgt = normalizeTranslationCode(to);

  if (src === tgt) {
    return { translated: text, engine: "none" };
  }

  const cached = getCachedTranslation(text, src, tgt);
  if (cached) {
    return { ...cached, cached: true };
  }

  const result = await translateUncached(text, src, tgt);
  setCachedTranslation(text, src, tgt, result);
  return { ...result, cached: false };
}
