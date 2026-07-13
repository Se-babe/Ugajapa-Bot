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
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(15_000),
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

async function botFallback(
  text: string,
  from: string,
  to: string
): Promise<RouteResult> {
  const result: BotTranslateResult = await botTranslate(text, from, to);
  return { translated: result.translated, engine: "ugajapa-bot-fallback" };
}

type EngineStep = {
  name: string;
  run: () => Promise<RouteResult>;
};

function engineChain(
  text: string,
  from: string,
  to: string
): EngineStep[] {
  const chain: EngineStep[] = [];
  const ugandan = UGANDAN_LANGS.has(from) || UGANDAN_LANGS.has(to);
  const japanese = from === "ja" || to === "ja";

  // Regional / Japanese pairs: neural engine first for quality.
  if (ugandan || japanese) {
    if (GROQ_API_KEY) {
      chain.push({
        name: "groq",
        run: async () => ({
          translated: await groqTranslate(text, from, to),
          engine: "groq",
        }),
      });
    }
  }

  // Global engine — covers all 197+ world languages for every pair.
  if (GOOGLE_API_KEY) {
    chain.push({
      name: "google",
      run: async () => ({
        translated: await googleTranslate(text, from, to),
        engine: ugandan || japanese ? "google-fallback" : "google",
      }),
    });
  }

  // Non-regional pairs: neural engine as secondary fallback.
  if (!ugandan && !japanese && GROQ_API_KEY) {
    chain.push({
      name: "groq-fallback",
      run: async () => ({
        translated: await groqTranslate(text, from, to),
        engine: "groq-fallback",
      }),
    });
  }

  // On-platform resilient fallback.
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
