#!/usr/bin/env node
/**
 * Push local translation-api/.env secrets to Render (translation-api service).
 *
 * Usage:
 *   export RENDER_API_KEY=rnd_...   # from https://dashboard.render.com/u/settings#api-keys
 *   node scripts/sync-render-env.mjs
 *
 * Optional:
 *   RENDER_SERVICE_NAME=translation-api  (default)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, "translation-api", ".env");

const RENDER_API_KEY = process.env.RENDER_API_KEY?.trim();
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME || "translation-api";

const SYNC_KEYS = [
  "GROQ_API_KEY",
  "GOOGLE_API_KEY",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "RESEND_API_KEY",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "VERIFICATION_RELAY_EMAIL",
];

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const vars = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function renderFetch(urlPath, options = {}) {
  const res = await fetch(`https://api.render.com/v1${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Render API ${urlPath} failed (${res.status}): ${JSON.stringify(body)}`
    );
  }
  return body;
}

async function findServiceId(name) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const data = await renderFetch(`/services?${qs}`);
    const items = data || [];
    for (const item of items) {
      const svc = item.service || item;
      if (svc.name === name) return svc.id;
    }
    cursor = items[items.length - 1]?.cursor;
    if (!cursor) break;
  }
  throw new Error(`Service "${name}" not found on Render. Deploy the blueprint first.`);
}

async function listEnvVars(serviceId) {
  const data = await renderFetch(`/services/${serviceId}/env-vars?limit=100`);
  const map = new Map();
  for (const item of data || []) {
    const ev = item.envVar || item;
    if (ev?.key) map.set(ev.key, ev);
  }
  return map;
}

async function upsertEnvVars(serviceId, updates) {
  const existing = await listEnvVars(serviceId);
  const merged = new Map(existing);
  for (const [key, value] of Object.entries(updates)) {
    merged.set(key, { key, value });
  }
  const payload = [...merged.values()].map((ev) => ({
    key: ev.key,
    value: ev.value,
  }));
  await renderFetch(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

async function triggerDeploy(serviceId) {
  await renderFetch(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ clearCache: "do_not_clear" }),
  });
}

async function main() {
  if (!RENDER_API_KEY) {
    console.error("Missing RENDER_API_KEY.");
    console.error("Create one at: https://dashboard.render.com/u/settings#api-keys");
    process.exit(1);
  }
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`Missing ${ENV_PATH}`);
    process.exit(1);
  }

  const local = parseEnvFile(ENV_PATH);
  const missing = SYNC_KEYS.filter((k) => !local[k]?.trim());
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Finding Render service "${SERVICE_NAME}"...`);
  const serviceId = await findServiceId(SERVICE_NAME);
  console.log(`Service id: ${serviceId}`);

  const existing = await listEnvVars(serviceId);
  const updates = {};
  for (const key of SYNC_KEYS) {
    const value = local[key];
    if (existing.get(key)?.value === value) {
      console.log(`  ${key}: unchanged`);
    } else {
      console.log(`  ${key}: updating`);
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    console.log("All env vars already match .env — skipping redeploy.");
    return;
  }

  await upsertEnvVars(serviceId, updates);

  console.log("Triggering redeploy...");
  await triggerDeploy(serviceId);
  console.log("Done. Env vars synced from translation-api/.env");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
