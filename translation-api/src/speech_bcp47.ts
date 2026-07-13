/** Maps short language codes to Google Speech / TTS BCP-47 tags. */
const SPEECH_BCP47: Record<string, string> = {
  en: "en-US",
  ja: "ja-JP",
  lg: "lg-UG",
  ach: "ach-UG",
  nyn: "nyn-UG",
  teo: "teo-UG",
  fr: "fr-FR",
  sw: "sw-KE",
  de: "de-DE",
  es: "es-ES",
  ar: "ar-SA",
  hi: "hi-IN",
  ko: "ko-KR",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-tw": "zh-TW",
  pt: "pt-BR",
  ru: "ru-RU",
  it: "it-IT",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
  vi: "vi-VN",
  th: "th-TH",
  id: "id-ID",
  ms: "ms-MY",
  bn: "bn-IN",
  ta: "ta-IN",
  te: "te-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  ur: "ur-PK",
  fa: "fa-IR",
  he: "he-IL",
  el: "el-GR",
  cs: "cs-CZ",
  ro: "ro-RO",
  hu: "hu-HU",
  sv: "sv-SE",
  da: "da-DK",
  fi: "fi-FI",
  no: "nb-NO",
  uk: "uk-UA",
  bg: "bg-BG",
  hr: "hr-HR",
  sk: "sk-SK",
  sl: "sl-SI",
  sr: "sr-RS",
  lt: "lt-LT",
  lv: "lv-LV",
  et: "et-EE",
  af: "af-ZA",
  sq: "sq-AL",
  am: "am-ET",
  hy: "hy-AM",
  az: "az-AZ",
  eu: "eu-ES",
  be: "be-BY",
  bs: "bs-BA",
  ca: "ca-ES",
  ceb: "ceb-PH",
  ny: "ny-MW",
  fil: "fil-PH",
  tl: "fil-PH",
  gl: "gl-ES",
  ka: "ka-GE",
  ht: "ht-HT",
  ha: "ha-NG",
  haw: "haw-US",
  is: "is-IS",
  ig: "ig-NG",
  ga: "ga-IE",
  jv: "jv-ID",
  kk: "kk-KZ",
  km: "km-KH",
  rw: "rw-RW",
  ku: "ku-TR",
  ky: "ky-KG",
  lo: "lo-LA",
  lb: "lb-LU",
  mk: "mk-MK",
  mg: "mg-MG",
  mi: "mi-NZ",
  mn: "mn-MN",
  my: "my-MM",
  ne: "ne-NP",
  or: "or-IN",
  ps: "ps-AF",
  sm: "sm-WS",
  gd: "gd-GB",
  st: "st-ZA",
  sn: "sn-ZW",
  sd: "sd-PK",
  si: "si-LK",
  so: "so-SO",
  su: "su-ID",
  tg: "tg-TJ",
  tt: "tt-RU",
  tk: "tk-TM",
  ug: "ug-CN",
  uz: "uz-UZ",
  cy: "cy-GB",
  xh: "xh-ZA",
  yi: "yi-DE",
  yo: "yo-NG",
  zu: "zu-ZA",
};

export function normalizeSpeechLanguageCode(code?: string): string {
  if (!code) return "";
  const trimmed = code.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.includes("-")) return trimmed.split("-")[0];
  return trimmed;
}

export function toSpeechBcp47(code?: string): string {
  const raw = (code || "").trim();
  if (!raw) return "";

  const lowered = raw.toLowerCase();
  if (SPEECH_BCP47[lowered]) return SPEECH_BCP47[lowered];

  const base = normalizeSpeechLanguageCode(raw);
  if (SPEECH_BCP47[base]) return SPEECH_BCP47[base];

  // Best-effort BCP-47 for any global language code.
  if (raw.includes("-")) return raw;
  return `${base}-${base.toUpperCase()}`;
}

export function toWhisperLanguage(code?: string): string | undefined {
  const base = normalizeSpeechLanguageCode(code);
  if (!base) return undefined;
  return base;
}

export function speechEncoding(mimeType: string, fileName: string): string {
  const mime = (mimeType || "").toLowerCase();
  const name = (fileName || "").toLowerCase();
  if (mime.includes("wav") || name.endsWith(".wav")) return "LINEAR16";
  if (mime.includes("webm") || name.endsWith(".webm")) return "WEBM_OPUS";
  if (mime.includes("ogg") || name.endsWith(".ogg")) return "OGG_OPUS";
  if (mime.includes("mp4") || mime.includes("m4a") || name.endsWith(".mp4") || name.endsWith(".m4a")) return "MP4";
  if (mime.includes("mpeg") || mime.includes("mp3") || name.endsWith(".mp3")) return "MP3";
  if (mime.includes("flac") || name.endsWith(".flac")) return "FLAC";
  return "WEBM_OPUS";
}
