import { createHash } from "crypto";
import type { RouteResult } from "./router";

type CacheEntry = {
  result: RouteResult;
  expiresAt: number;
  lastAccessed: number;
};

const TTL_MS = Math.max(
  0,
  parseInt(process.env.TRANSLATION_CACHE_TTL_SECONDS || "3600", 10) * 1000
);
const MAX_ENTRIES = Math.max(
  100,
  parseInt(process.env.TRANSLATION_CACHE_MAX_ENTRIES || "10000", 10)
);

const store = new Map<string, CacheEntry>();

export function isTranslationCacheEnabled(): boolean {
  return TTL_MS > 0;
}

export function getTranslationCacheStats(): {
  enabled: boolean;
  entries: number;
  ttl_seconds: number;
  max_entries: number;
} {
  evictExpired();
  return {
    enabled: isTranslationCacheEnabled(),
    entries: store.size,
    ttl_seconds: TTL_MS / 1000,
    max_entries: MAX_ENTRIES,
  };
}

function cacheKey(text: string, from: string, to: string): string {
  return createHash("sha256").update(`${from}\0${to}\0${text}`, "utf8").digest("hex");
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestAccess = Infinity;
  for (const [key, entry] of store) {
    if (entry.lastAccessed < oldestAccess) {
      oldestAccess = entry.lastAccessed;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    store.delete(oldestKey);
  }
}

export function getCachedTranslation(
  text: string,
  from: string,
  to: string
): RouteResult | undefined {
  if (!isTranslationCacheEnabled()) return undefined;

  const key = cacheKey(text, from, to);
  const entry = store.get(key);
  if (!entry) return undefined;

  const now = Date.now();
  if (entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }

  entry.lastAccessed = now;
  return entry.result;
}

export function setCachedTranslation(
  text: string,
  from: string,
  to: string,
  result: RouteResult
): void {
  if (!isTranslationCacheEnabled()) return;

  if (store.size >= MAX_ENTRIES) {
    evictExpired();
    while (store.size >= MAX_ENTRIES) {
      evictOldest();
    }
  }

  const now = Date.now();
  store.set(cacheKey(text, from, to), {
    result,
    expiresAt: now + TTL_MS,
    lastAccessed: now,
  });
}
