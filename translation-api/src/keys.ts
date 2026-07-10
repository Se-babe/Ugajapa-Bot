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
  const random = crypto.randomBytes(24).toString("base64url");
  return `ugj_${env}_${random}`;
}

export async function generateKey(req: Request, res: Response): Promise<void> {
  const name = (req.body as { name?: string }).name || "Default Key";
  const env =
    (req.body as { env?: string }).env === "test" ? ("test" as const) : ("live" as const);

  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.isAdmin) {
    res.status(403).json({
      error: "Admin accounts cannot generate customer API keys. Sign up a regular user account instead.",
    });
    return;
  }

  const keyValue = generateKeyValue(env);
  const keyHash = await bcrypt.hash(keyValue, 12);
  const keyPrefix = keyValue.slice(0, 16);

  const result = await query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [req.user.id, keyHash, keyPrefix, name]
  );

  const row = result.rows[0];
  res.status(201).json({
    key_id: row.id,
    key_value: keyValue,
    name,
    created_at: row.created_at.toISOString(),
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
      key_value: `${k.key_prefix}${"*".repeat(12)}`,
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

/** Admin — list every key (active and revoked) for a given user. */
export async function adminListUserKeys(req: Request, res: Response): Promise<void> {
  const { user_id } = req.params;

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
    [user_id]
  );

  res.json({
    user_id,
    keys: result.rows.map((k) => ({
      key_id: k.id,
      name: k.name,
      key_value: `${k.key_prefix}${"*".repeat(12)}`,
      created_at: k.created_at.toISOString(),
      last_used: k.last_used?.toISOString() ?? null,
      revoked: k.revoked_at !== null,
    })),
  });
}

/** Admin — revoke (deactivate) any user's key by id. Does not delete the row. */
export async function adminRevokeKey(req: Request, res: Response): Promise<void> {
  const { key_id } = req.params;

  const result = await query<{ id: string; user_id: string }>(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id, user_id`,
    [key_id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: "Key not found or already revoked" });
    return;
  }

  res.json({ message: "API key revoked", key_id, user_id: result.rows[0].user_id });
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const rawKey = req.headers["x-api-key"];
  const keyValue = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!keyValue || (!keyValue.startsWith("ugj_live_") && !keyValue.startsWith("ugj_test_"))) {
    res.status(401).json({ error: "Missing or invalid X-API-Key header" });
    return;
  }

  const prefix = keyValue.slice(0, 16);
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
