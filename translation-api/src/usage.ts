import { Request, Response } from "express";
import { query } from "./db";

export const PLAN_LIMITS: Record<string, number> = {
  free: 50_000,
  starter: 500_000,
  business: 5_000_000,
  enterprise: Number.MAX_SAFE_INTEGER,
};

export const PLAN_PRICES: Record<
  string,
  { base: number; overagePer10k: number }
> = {
  free: { base: 0, overagePer10k: 0 },
  starter: { base: 9, overagePer10k: 0.5 },
  business: { base: 49, overagePer10k: 0.3 },
  enterprise: { base: 0, overagePer10k: 0 },
};

export function countCharacters(text: string): number {
  return [...text].length;
}

export function getPlanLimit(plan: string): number {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

export async function apiKeyUsage(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
       AND timestamp < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [req.apiKey.userId]
  );

  const used = parseInt(result.rows[0].total, 10);
  const limit = getPlanLimit(req.apiKey.plan);

  res.json({
    period: new Date().toISOString().slice(0, 7),
    plan: req.apiKey.plan,
    usage: {
      sourceCharacters: used,
      billedCharacters: used,
      limit: limit === Number.MAX_SAFE_INTEGER ? null : limit,
      remaining: limit === Number.MAX_SAFE_INTEGER ? null : Math.max(0, limit - used),
    },
    quotaExceeded: used >= limit,
  });
}

export function calculateBill(
  plan: string,
  charactersTotal: number
): number {
  const pricing = PLAN_PRICES[plan] ?? PLAN_PRICES.free;
  if (plan === "enterprise") return 0;
  if (plan === "free") return 0;

  const limit = getPlanLimit(plan);
  const overage = Math.max(0, charactersTotal - limit);
  const overageBlocks = Math.ceil(overage / 10_000);
  return Number((pricing.base + overageBlocks * pricing.overagePer10k).toFixed(2));
}
