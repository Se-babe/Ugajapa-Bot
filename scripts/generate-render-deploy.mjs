#!/usr/bin/env node
/**
 * Generate render.deploy.yaml with secrets from translation-api/.env.
 * File is gitignored — use for Render Blueprint Path: render.deploy.yaml
 *
 * Usage: node scripts/generate-render-deploy.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, "translation-api", ".env");
const SRC = path.join(ROOT, "render.yaml");
const OUT = path.join(ROOT, "render.deploy.yaml");

const INJECT_KEYS = new Set(["GROQ_API_KEY", "GOOGLE_API_KEY", "ADMIN_PASSWORD"]);

function parseEnv(filePath) {
  const vars = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    vars[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vars;
}

const env = parseEnv(ENV_PATH);
const lines = fs.readFileSync(SRC, "utf8").split("\n");
const out = [];

for (let i = 0; i < lines.length; i++) {
  const keyMatch = lines[i].match(/^\s+- key: (\w+)$/);
  if (
    keyMatch &&
    INJECT_KEYS.has(keyMatch[1]) &&
    lines[i + 1]?.trim() === "sync: false"
  ) {
    const key = keyMatch[1];
    const val = env[key];
    if (!val) {
      console.error(`Missing ${key} in ${ENV_PATH}`);
      process.exit(1);
    }
    out.push(lines[i]);
    out.push(`        value: ${JSON.stringify(val)}`);
    i++; // skip "sync: false"
    continue;
  }
  out.push(lines[i]);
}

fs.writeFileSync(OUT, out.join("\n"));
console.log(`Wrote ${OUT}`);
console.log("Render Blueprint → Blueprint Path: render.deploy.yaml");
