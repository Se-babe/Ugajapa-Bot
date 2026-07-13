import {
  normalizeSpeechLanguageCode,
  speechEncoding,
  toSpeechBcp47,
} from "./speech_bcp47";

const GOOGLE_SPEECH_API_KEY =
  process.env.GOOGLE_SPEECH_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  "";

const AUTO_DETECT_ROTATIONS = [
  ["en-US", "es-ES", "zh-CN", "ar-SA"],
  ["hi-IN", "fr-FR", "pt-BR", "ru-RU"],
  ["ja-JP", "de-DE", "sw-KE", "lg-UG"],
  ["ko-KR", "it-IT", "tr-TR", "vi-VN"],
];

let autoDetectRotation = 0;

export type GoogleTranscription = {
  text: string;
  detected_language: string;
  engine: string;
  confidence?: number;
};

export function isGoogleSpeechEnabled(): boolean {
  return GOOGLE_SPEECH_API_KEY.length > 0;
}

function uniqueBcp47(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const bcp47 = toSpeechBcp47(code);
    if (!bcp47 || seen.has(bcp47)) continue;
    seen.add(bcp47);
    out.push(bcp47);
  }
  return out;
}

function buildLanguageConfig(
  languageHint?: string,
  languageCandidates?: string[]
): { languageCode: string; alternativeLanguageCodes: string[] } {
  const explicit = toSpeechBcp47(languageHint);
  if (explicit) {
    return { languageCode: explicit, alternativeLanguageCodes: [] };
  }

  const fromChannel = uniqueBcp47(languageCandidates || []);
  if (fromChannel.length > 0) {
    return {
      languageCode: fromChannel[0],
      alternativeLanguageCodes: fromChannel.slice(1, 4),
    };
  }

  const rotation =
    AUTO_DETECT_ROTATIONS[autoDetectRotation % AUTO_DETECT_ROTATIONS.length];
  autoDetectRotation += 1;
  return {
    languageCode: rotation[0],
    alternativeLanguageCodes: rotation.slice(1, 4),
  };
}

export async function transcribeWithGoogleSpeech(
  buffer: Buffer,
  fileName: string,
  options?: {
    mimeType?: string;
    languageHint?: string;
    languageCandidates?: string[];
    durationSeconds?: number;
  }
): Promise<GoogleTranscription> {
  if (!GOOGLE_SPEECH_API_KEY) {
    throw new Error("Google Speech API key not configured");
  }

  const mimeType = options?.mimeType || "";
  const encoding = speechEncoding(mimeType, fileName);
  const langConfig = buildLanguageConfig(
    options?.languageHint,
    options?.languageCandidates
  );

  const duration = options?.durationSeconds || 0;
  const model =
    duration > 0 && duration <= 15
      ? "latest_short"
      : langConfig.alternativeLanguageCodes.length > 0
        ? "latest_long"
        : "latest_short";

  const url = new URL(
    "https://speech.googleapis.com/v1/speech:recognize"
  );
  url.searchParams.set("key", GOOGLE_SPEECH_API_KEY);

  const body = {
    config: {
      encoding,
      languageCode: langConfig.languageCode,
      ...(langConfig.alternativeLanguageCodes.length > 0
        ? { alternativeLanguageCodes: langConfig.alternativeLanguageCodes }
        : {}),
      enableAutomaticPunctuation: true,
      model,
    },
    audio: { content: buffer.toString("base64") },
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google Speech error ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as {
    results?: {
      alternatives?: { transcript?: string; confidence?: number }[];
      languageCode?: string;
    }[];
  };

  const results = data.results || [];
  const text = results
    .map((r) => r.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim();

  if (!text) {
    throw new Error("No speech detected in the recording");
  }

  const detectedFromResult = normalizeSpeechLanguageCode(
    results[0]?.languageCode
  );
  const detected =
    detectedFromResult ||
    normalizeSpeechLanguageCode(options?.languageHint) ||
    normalizeSpeechLanguageCode(langConfig.languageCode);

  const confidence = results[0]?.alternatives?.[0]?.confidence;

  return {
    text,
    detected_language: detected,
    engine: "google-speech",
    confidence,
  };
}
