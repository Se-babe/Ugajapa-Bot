import { toSpeechBcp47 } from "./speech_bcp47";

const GOOGLE_TTS_API_KEY =
  process.env.GOOGLE_TTS_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  "";

type VoiceGender = "MALE" | "FEMALE" | "NEUTRAL";

export function isGoogleTTSEnabled(): boolean {
  return GOOGLE_TTS_API_KEY.length > 0;
}

function parseGender(input?: string): VoiceGender {
  const g = (input || "neutral").toLowerCase();
  if (g === "male" || g === "m") return "MALE";
  if (g === "female" || g === "f") return "FEMALE";
  return "NEUTRAL";
}

export async function synthesizeSpeech(
  text: string,
  language: string,
  voiceGender?: string
): Promise<Buffer> {
  if (!GOOGLE_TTS_API_KEY) {
    throw new Error("Google Text-to-Speech API key not configured");
  }

  const languageCode = toSpeechBcp47(language) || "en-US";
  const ssmlGender = parseGender(voiceGender);

  const url = new URL(
    "https://texttospeech.googleapis.com/v1/text:synthesize"
  );
  url.searchParams.set("key", GOOGLE_TTS_API_KEY);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, ssmlGender },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google TTS error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error("Google TTS returned empty audio");
  }

  return Buffer.from(data.audioContent, "base64");
}
