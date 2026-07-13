import { createHash } from "crypto";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

/** Display names when Google is unavailable. */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  lg: "Luganda",
  ach: "Acholi",
  nyn: "Runyankole",
  teo: "Ateso",
  fr: "French",
  sw: "Swahili",
  de: "German",
  es: "Spanish",
  ar: "Arabic",
  hi: "Hindi",
  ko: "Korean",
  zh: "Chinese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  pt: "Portuguese",
  ru: "Russian",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ms: "Malay",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  pa: "Punjabi",
  ur: "Urdu",
  fa: "Persian",
  he: "Hebrew",
  el: "Greek",
  cs: "Czech",
  ro: "Romanian",
  hu: "Hungarian",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  uk: "Ukrainian",
  bg: "Bulgarian",
  hr: "Croatian",
  sk: "Slovak",
  sl: "Slovenian",
  sr: "Serbian",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
  af: "Afrikaans",
  sq: "Albanian",
  am: "Amharic",
  hy: "Armenian",
  az: "Azerbaijani",
  eu: "Basque",
  be: "Belarusian",
  bs: "Bosnian",
  ca: "Catalan",
  ceb: "Cebuano",
  ny: "Chichewa",
  co: "Corsican",
  eo: "Esperanto",
  tl: "Filipino",
  fy: "Frisian",
  gl: "Galician",
  ka: "Georgian",
  ht: "Haitian Creole",
  ha: "Hausa",
  haw: "Hawaiian",
  hmn: "Hmong",
  is: "Icelandic",
  ig: "Igbo",
  ga: "Irish",
  jv: "Javanese",
  kk: "Kazakh",
  km: "Khmer",
  rw: "Kinyarwanda",
  ku: "Kurdish",
  ky: "Kyrgyz",
  lo: "Lao",
  la: "Latin",
  lb: "Luxembourgish",
  mk: "Macedonian",
  mg: "Malagasy",
  mi: "Maori",
  mn: "Mongolian",
  my: "Myanmar (Burmese)",
  ne: "Nepali",
  or: "Odia",
  ps: "Pashto",
  sm: "Samoan",
  gd: "Scottish Gaelic",
  st: "Sesotho",
  sn: "Shona",
  sd: "Sindhi",
  si: "Sinhala",
  so: "Somali",
  su: "Sundanese",
  tg: "Tajik",
  tt: "Tatar",
  tk: "Turkmen",
  ug: "Uyghur",
  uz: "Uzbek",
  cy: "Welsh",
  xh: "Xhosa",
  yi: "Yiddish",
  yo: "Yoruba",
  zu: "Zulu",
};

/** Regional languages always merged into the global catalog. */
const EXTRA_LANGUAGES: Record<string, string> = {
  nyn: "Runyankole",
  teo: "Ateso",
  ach: "Acholi",
  lg: "Luganda",
};

export type LanguageInfo = {
  code: string;
  name: string;
};

export type LanguagesResponse = {
  scope: "global";
  count: number;
  languages: LanguageInfo[];
};

let cachedLanguages: { languages: LanguageInfo[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeLanguageCode(code?: string): string {
  if (!code) return "";
  return code.trim().toLowerCase();
}

/** Map aliases and regional variants to engine-compatible codes. */
const TRANSLATION_CODE_ALIASES: Record<string, string> = {
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hant": "zh-TW",
  fil: "tl",
  iw: "he",
  jw: "jv",
  nb: "no",
  in: "id",
  mo: "ro",
};

export function normalizeTranslationCode(code?: string): string {
  const raw = (code || "").trim();
  if (!raw) return "";

  const lowered = raw.toLowerCase();
  if (TRANSLATION_CODE_ALIASES[lowered]) {
    return TRANSLATION_CODE_ALIASES[lowered];
  }

  if (lowered.includes("-")) {
    const [base, region] = lowered.split("-");
    if (base === "zh") {
      return region === "tw" ? "zh-TW" : "zh-CN";
    }
    // Keep regional codes Google supports (e.g. pt-BR, zh-CN)
    if (region.length === 2) {
      return `${base}-${region.toUpperCase()}`;
    }
    return lowered;
  }

  return lowered;
}

export function languageDisplayName(code: string): string {
  const normalized = normalizeLanguageCode(code);
  if (!normalized) return code;

  const fromCache = cachedLanguages?.languages.find(
    (lang) => lang.code === normalized
  );
  if (fromCache) return fromCache.name;

  return (
    LANGUAGE_DISPLAY_NAMES[normalized] ||
    EXTRA_LANGUAGES[normalized] ||
    LANGUAGE_DISPLAY_NAMES[normalized.split("-")[0]] ||
    normalized
  );
}

async function fetchGoogleLanguages(): Promise<LanguageInfo[]> {
  if (!GOOGLE_API_KEY) return [];

  const url = new URL(
    "https://translation.googleapis.com/language/translate/v2/languages"
  );
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("target", "en");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Google languages error ${res.status}`);
  }

  const data = (await res.json()) as {
    data?: { languages?: { language: string; name: string }[] };
  };

  return (data.data?.languages || []).map((lang) => ({
    code: lang.language,
    name: lang.name,
  }));
}

async function buildLanguageCatalog(): Promise<LanguageInfo[]> {
  const byCode = new Map<string, string>();

  try {
    const googleLangs = await fetchGoogleLanguages();
    for (const lang of googleLangs) {
      byCode.set(lang.code, lang.name);
    }
  } catch (err) {
    console.warn("Failed to fetch Google languages:", err);
  }

  for (const [code, name] of Object.entries(EXTRA_LANGUAGES)) {
    if (!byCode.has(code)) byCode.set(code, name);
  }

  if (byCode.size === 0) {
    for (const [code, name] of Object.entries(LANGUAGE_DISPLAY_NAMES)) {
      byCode.set(code, name);
    }
  }

  return Array.from(byCode.entries())
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSupportedLanguages(): Promise<LanguageInfo[]> {
  if (cachedLanguages && cachedLanguages.expiresAt > Date.now()) {
    return cachedLanguages.languages;
  }

  const languages = await buildLanguageCatalog();
  cachedLanguages = {
    languages,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  return languages;
}

export async function getLanguagesResponse(): Promise<LanguagesResponse> {
  const languages = await getSupportedLanguages();
  return {
    scope: "global",
    count: languages.length,
    languages,
  };
}

export async function getSupportedLanguageCodes(): Promise<Set<string>> {
  const languages = await getSupportedLanguages();
  const codes = new Set<string>();
  for (const lang of languages) {
    codes.add(lang.code);
    codes.add(normalizeLanguageCode(lang.code));
    const base = normalizeLanguageCode(lang.code).split("-")[0];
    if (base) codes.add(base);
  }
  return codes;
}

export async function isSupportedLanguage(code?: string): Promise<boolean> {
  const normalized = normalizeTranslationCode(code);
  if (!normalized) return false;

  const supported = await getSupportedLanguageCodes();
  if (supported.has(normalized)) return true;

  const base = normalized.split("-")[0];
  if (supported.has(base)) return true;

  // When the global engine is configured, accept any reasonable ISO/BCP-47 code.
  if (GOOGLE_API_KEY && /^[a-z]{2,3}(-[a-z]{2,8})?$/i.test(normalized)) {
    return true;
  }

  return false;
}

export function detectLanguageHeuristic(text: string): {
  language: string;
  confidence: number;
} {
  const sample = text.trim();
  let language = "en";
  let confidence = 0.5;

  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(sample)) {
    language = "zh";
    confidence = 0.85;
  } else if (/[\u3040-\u30ff]/.test(sample)) {
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
  } else if (/[\u0600-\u06ff]/.test(sample)) {
    language = "ar";
    confidence = 0.8;
  } else if (/[\u0900-\u097f]/.test(sample)) {
    language = "hi";
    confidence = 0.8;
  } else if (/[\u0400-\u04ff]/.test(sample)) {
    language = "ru";
    confidence = 0.75;
  } else if (/^[A-Za-z0-9\s.,!?'"-]+$/.test(sample)) {
    language = "en";
    confidence = 0.65;
  }

  return { language, confidence };
}

const DETECT_CACHE_TTL_MS = Math.max(
  0,
  parseInt(process.env.DETECT_CACHE_TTL_SECONDS || "3600", 10) * 1000
);
const detectCache = new Map<
  string,
  { language: string; confidence: number; expiresAt: number }
>();

function detectCacheKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function detectLanguage(text: string): Promise<{
  language: string;
  confidence: number;
}> {
  const sample = text.trim();
  if (!sample) return { language: "en", confidence: 0 };

  if (DETECT_CACHE_TTL_MS > 0) {
    const hit = detectCache.get(detectCacheKey(sample));
    if (hit && hit.expiresAt > Date.now()) {
      return { language: hit.language, confidence: hit.confidence };
    }
    if (hit) detectCache.delete(detectCacheKey(sample));
  }

  const storeDetect = (language: string, confidence: number) => {
    if (DETECT_CACHE_TTL_MS > 0) {
      detectCache.set(detectCacheKey(sample), {
        language,
        confidence,
        expiresAt: Date.now() + DETECT_CACHE_TTL_MS,
      });
    }
    return { language, confidence };
  };

  if (GOOGLE_API_KEY) {
    try {
      const url = new URL(
        "https://translation.googleapis.com/language/translate/v2/detect"
      );
      url.searchParams.set("key", GOOGLE_API_KEY);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: sample }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          data?: {
            detections?: { language: string; confidence?: number }[][];
          };
        };
        const top = data.data?.detections?.[0]?.[0];
        if (top?.language) {
          return storeDetect(top.language, top.confidence ?? 0.5);
        }
      }
    } catch (err) {
      console.warn("Google language detect failed, using heuristic:", err);
    }
  }

  const heuristic = detectLanguageHeuristic(sample);
  return storeDetect(heuristic.language, heuristic.confidence);
}
