export const PLAN_LIMITS: Record<string, number> = {
  free: 50_000,
  starter: 500_000,
  business: 5_000_000,
  enterprise: Number.MAX_SAFE_INTEGER,
};

export const PLAN_PRICES: Record<
  string,
  { base: number; overagePer10k: number; label: string }
> = {
  free: { base: 0, overagePer10k: 0, label: "Free" },
  starter: { base: 9, overagePer10k: 0.5, label: "Starter" },
  business: { base: 49, overagePer10k: 0.3, label: "Business" },
  enterprise: { base: 0, overagePer10k: 0, label: "Enterprise" },
};

export const PLAN_ORDER = ["free", "starter", "business", "enterprise"] as const;

export type BillingBreakdown = {
  plan: string;
  characters_total: number;
  included_characters: number;
  overage_characters: number;
  base_usd: number;
  overage_usd: number;
  total_usd: number;
};

export function countCharacters(text: string): number {
  return [...text].length;
}

export function getPlanLimit(plan: string): number {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

/** Suggested next plan when the user needs more quota. */
export function nextUpgradePlan(plan: string): string | null {
  if (plan === "free") return "starter";
  if (plan === "starter") return "business";
  return null;
}

export function monthQuotaResetAt(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

export function quotaExceededPayload(plan: string, used: number, limit: number) {
  const upgrade = nextUpgradePlan(plan);
  return {
    error: "Monthly character quota exceeded. Upgrade your plan to continue translating.",
    code: "QUOTA_EXCEEDED",
    used,
    limit,
    plan,
    upgrade_plan: upgrade,
    hint: upgrade
      ? `Upgrade to ${upgrade} via Settings → Billing (card payment).`
      : "Contact support@ugajapa.ac.ug for Enterprise unlimited quota.",
  };
}

const ACTIVE_SUB_STATUSES = new Set(["active", "trialing", "admin_granted"]);

/**
 * Paid self-serve plans (starter/business) only count when Stripe has an
 * active card subscription (or an explicit admin grant). Otherwise demote
 * to free so plan cannot "stick" without payment authentication.
 */
export function effectivePlan(
  storedPlan: string,
  stripeSubscriptionStatus: string | null | undefined
): string {
  if (storedPlan === "free" || storedPlan === "enterprise") {
    return storedPlan;
  }
  if (
    (storedPlan === "starter" || storedPlan === "business") &&
    ACTIVE_SUB_STATUSES.has(stripeSubscriptionStatus || "")
  ) {
    return storedPlan;
  }
  return "free";
}

export function getBillingBreakdown(
  plan: string,
  charactersTotal: number
): BillingBreakdown {
  const pricing = PLAN_PRICES[plan] ?? PLAN_PRICES.free;
  const limit = getPlanLimit(plan);

  if (plan === "enterprise") {
    return {
      plan,
      characters_total: charactersTotal,
      included_characters: charactersTotal,
      overage_characters: 0,
      base_usd: 0,
      overage_usd: 0,
      total_usd: 0,
    };
  }

  if (plan === "free") {
    return {
      plan,
      characters_total: charactersTotal,
      included_characters: Math.min(charactersTotal, limit),
      overage_characters: Math.max(0, charactersTotal - limit),
      base_usd: 0,
      overage_usd: 0,
      total_usd: 0,
    };
  }

  const overage = Math.max(0, charactersTotal - limit);
  const overageBlocks = Math.ceil(overage / 10_000);
  const overage_usd = Number((overageBlocks * pricing.overagePer10k).toFixed(2));
  const base_usd = pricing.base;

  return {
    plan,
    characters_total: charactersTotal,
    included_characters: Math.min(charactersTotal, limit),
    overage_characters: overage,
    base_usd,
    overage_usd,
    total_usd: Number((base_usd + overage_usd).toFixed(2)),
  };
}

export function calculateBill(
  plan: string,
  charactersTotal: number
): number {
  return getBillingBreakdown(plan, charactersTotal).total_usd;
}
