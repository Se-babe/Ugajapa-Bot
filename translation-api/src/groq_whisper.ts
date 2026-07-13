import { normalizeSpeechLanguageCode, toWhisperLanguage } from "./speech_bcp47";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";

export type WhisperSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

export type GroqTranscription = {
  text: string;
  detected_language: string;
  engine: string;
  segments?: WhisperSegment[];
};

export function isGroqWhisperEnabled(): boolean {
  return GROQ_API_KEY.length > 0;
}

function buildSrtFromSegments(segments: WhisperSegment[]): string {
  return segments
    .filter((s) => s.text.trim())
    .map((s, i) => {
      const start = formatSrtTime(s.start);
      const end = formatSrtTime(s.end);
      return `${i + 1}\n${start} --> ${end}\n${s.text.trim()}`;
    })
    .join("\n\n");
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export async function transcribeWithGroq(
  buffer: Buffer,
  fileName: string,
  options?: {
    languageHint?: string;
    mimeType?: string;
    verbose?: boolean;
  }
): Promise<GroqTranscription> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not configured");
  }

  const form = new FormData();
  const blob = new Blob([buffer], {
    type: options?.mimeType || "application/octet-stream",
  });
  form.append("file", blob, fileName || "audio.webm");
  form.append("model", GROQ_WHISPER_MODEL);
  form.append(
    "response_format",
    options?.verbose ? "verbose_json" : "json"
  );

  const whisperLang = toWhisperLanguage(options?.languageHint);
  if (whisperLang) {
    form.append("language", whisperLang);
  }

  const res = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq Whisper error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    text?: string;
    language?: string;
    segments?: { id: number; start: number; end: number; text: string }[];
  };

  const text = String(data.text || "").trim();
  if (!text) {
    throw new Error("No speech detected in the recording");
  }

  const detected =
    normalizeSpeechLanguageCode(data.language) ||
    normalizeSpeechLanguageCode(options?.languageHint) ||
    "";

  const segments = (data.segments || []).map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.text,
  }));

  return {
    text,
    detected_language: detected,
    engine: `groq-whisper:${GROQ_WHISPER_MODEL}`,
    segments: segments.length ? segments : undefined,
  };
}

export function segmentsToSrt(segments: WhisperSegment[]): string {
  return buildSrtFromSegments(segments);
}
