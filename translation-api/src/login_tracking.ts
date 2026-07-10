import { Request, Response } from "express";
import { query } from "./db";

export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(",")[0].trim() || req.ip || "unknown").slice(0, 64);
}

export function clientUserAgent(req: Request): string {
  return (req.headers["user-agent"] || "unknown").slice(0, 512);
}

export async function recordLoginEvent(params: {
  userId: string | null;
  email: string;
  success: boolean;
  reason?: string;
  req: Request;
}): Promise<void> {
  await query(
    `INSERT INTO login_events (user_id, email, success, reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.userId,
      params.email.toLowerCase(),
      params.success,
      params.reason || null,
      clientIp(params.req),
      clientUserAgent(params.req),
    ]
  );
}

/** Admin — recent login activity across the whole platform. */
export async function adminLoginActivity(req: Request, res: Response): Promise<void> {
  const limit = Math.min(200, parseInt(String(req.query.limit || "100"), 10) || 100);
  const result = await query<{
    id: string;
    user_id: string | null;
    email: string;
    success: boolean;
    reason: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, email, success, reason, ip_address, user_agent, created_at
     FROM login_events
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  res.json({
    events: result.rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      email: r.email,
      success: r.success,
      reason: r.reason,
      ip_address: r.ip_address,
      user_agent: r.user_agent,
      created_at: r.created_at.toISOString(),
    })),
  });
}

/** Admin — login history for one specific user. */
export async function adminUserLoginActivity(
  req: Request,
  res: Response
): Promise<void> {
  const { user_id } = req.params;
  const limit = Math.min(200, parseInt(String(req.query.limit || "50"), 10) || 50);

  const result = await query<{
    id: string;
    success: boolean;
    reason: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, success, reason, ip_address, user_agent, created_at
     FROM login_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [user_id, limit]
  );

  res.json({
    user_id,
    events: result.rows.map((r) => ({
      id: r.id,
      success: r.success,
      reason: r.reason,
      ip_address: r.ip_address,
      user_agent: r.user_agent,
      created_at: r.created_at.toISOString(),
    })),
  });
}
