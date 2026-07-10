import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { query } from "./db";

export type ApiKeyContext = {
  keyId: string;
  userId: string;
  plan: string;
  name: string;
};

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyContext;
    }
  }
}

function generateKeyValue(env: "live" | "test" = "live"): string {
  const segments = [
    crypto.randomBytes(4).toString("hex"),
    crypto.randomBytes(4).toString("hex"),
    crypto.randomBytes(4).toString("hex"),
  ];
  return `ugj_${env}_${segments.join("-")}`;
}

/** Mask stored key for display: ugj_live_a1b2c3d4-••••-••••-•••••••• */
export function maskKeyPreview(prefix: string): string {
  const base = prefix.replace(/-+$/, "");
  if (base.startsWith("ugj_live_") || base.startsWith("ugj_test_")) {
    const env = base.startsWith("ugj_live_") ? "live" : "test";
    const visible = base.slice(`ugj_${env}_`.length).slice(0, 8) || "••••";
    return `ugj_${env}_${visible}-••••-••••-••••••••`;
  }
  return `${base}${"•".repeat(Math.max(0, 20 - base.length))}`;
}

export async function generateKey(req: Request, res: Response): Promise<void> {
  const name = (req.body as { name?: string }).name || "Default Key";
  const env =
    (req.body as { env?: string }).env === "test" ? ("test" as const) : ("live" as const);

  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const keyValue = generateKeyValue(env);
  const keyHash = await bcrypt.hash(keyValue, 12);
  const keyPrefix = keyValue.slice(0, 20);

  const result = await query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [req.user.id, keyHash, keyPrefix, name]
  );

  const row = result.rows[0];
  res.status(201).json({
    key_id: row.id,
    key: keyValue,
    key_value: keyValue,
    key_preview: maskKeyPreview(keyPrefix),
    name,
    env,
    created_at: row.created_at.toISOString(),
    message: "Copy this key now — it will not be shown again.",
  });
}

export async function listKeys(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const result = await query<{
    id: string;
    name: string;
    key_prefix: string;
    created_at: Date;
    last_used: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, key_prefix, created_at, last_used, revoked_at
     FROM api_keys WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.user.id]
  );

  res.json({
    keys: result.rows.map((k) => ({
      key_id: k.id,
      name: k.name,
      key_preview: maskKeyPreview(k.key_prefix),
      key_value: maskKeyPreview(k.key_prefix),
      env: k.key_prefix.includes("ugj_test_") ? "test" : "live",
      created_at: k.created_at.toISOString(),
      last_used: k.last_used?.toISOString() ?? null,
      revoked: k.revoked_at !== null,
    })),
  });
}

export async function revokeKey(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { key_id } = req.params;
  const result = await query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [key_id, req.user.id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: "Key not found or already revoked" });
    return;
  }

  res.json({ message: "API key revoked", key_id });
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let keyValue: string | undefined;

  const headerKey = req.headers["x-api-key"];
  if (headerKey) {
    keyValue = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  }

  if (!keyValue) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const bearer = auth.slice(7);
      if (bearer.startsWith("ugj_live_") || bearer.startsWith("ugj_test_")) {
        keyValue = bearer;
      }
    }
  }

  if (!keyValue || (!keyValue.startsWith("ugj_live_") && !keyValue.startsWith("ugj_test_"))) {
    res.status(401).json({ error: "Missing or invalid API key (X-API-Key or Bearer)" });
    return;
  }

  const prefix = keyValue.slice(0, 20);
  const candidates = await query<{
    id: string;
    user_id: string;
    key_hash: string;
    name: string;
    revoked_at: Date | null;
    plan: string;
    active: boolean;
  }>(
    `SELECT k.id, k.user_id, k.key_hash, k.name, k.revoked_at, u.plan, u.active
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_prefix = $1`,
    [prefix]
  );

  for (const candidate of candidates.rows) {
    const match = await bcrypt.compare(keyValue, candidate.key_hash);
    if (!match) continue;

    if (candidate.revoked_at) {
      res.status(401).json({ error: "API key has been revoked" });
      return;
    }
    if (!candidate.active) {
      res.status(401).json({ error: "User account is inactive" });
      return;
    }

    await query("UPDATE api_keys SET last_used = NOW() WHERE id = $1", [
      candidate.id,
    ]);

    req.apiKey = {
      keyId: candidate.id,
      userId: candidate.user_id,
      plan: candidate.plan,
      name: candidate.name,
    };
    next();
    return;
  }

  res.status(401).json({ error: "Invalid API key" });
}
