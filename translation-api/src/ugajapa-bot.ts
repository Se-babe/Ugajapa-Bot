function botBaseUrl(): string {
  const raw = process.env.BOT_URL || "http://localhost:8000";
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

export type BotTranslateResult = {
  translated: string;
  engine: string;
};

export async function botHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${botBaseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function botTranslate(
  text: string,
  fromLang: string,
  toLang: string
): Promise<BotTranslateResult> {
  const res = await fetch(`${botBaseUrl()}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, from_lang: fromLang, to_lang: toLang }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`UgaJapa Bot error ${res.status}: ${body}`);
  }

  return (await res.json()) as BotTranslateResult;
}

export async function botLanguages(): Promise<string[]> {
  try {
    const res = await fetch(`${botBaseUrl()}/languages`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Bot languages error ${res.status}`);
    const data = (await res.json()) as { languages: string[] };
    return data.languages;
  } catch {
    const { getSupportedLanguages } = await import("./languages");
    const langs = await getSupportedLanguages();
    return langs.map((l) => l.code);
  }
}
