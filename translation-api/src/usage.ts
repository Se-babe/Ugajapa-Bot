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
