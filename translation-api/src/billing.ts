import { Request, Response } from "express";
import cron from "node-cron";
import { query } from "./db";
import {
  getBillingBreakdown,
  getPlanLimit,
  PLAN_LIMITS,
  PLAN_PRICES,
  nextUpgradePlan,
  type BillingBreakdown,
} from "./usage";
import { isStripeEnabled, payableAmountUsd, resolvePlanPeriod } from "./stripe_billing";

export async function usageSummary(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
       AND timestamp < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [req.user.id]
  );

  const used = parseInt(result.rows[0].total, 10);
  const limit = getPlanLimit(req.user.plan);
  const billing = getBillingBreakdown(req.user.plan, used);
  const unlimited = limit === Number.MAX_SAFE_INTEGER;
  const remaining = unlimited ? null : Math.max(0, limit - used);
  const quotaExceeded = !unlimited && used >= limit;
  const quotaWarning =
    !unlimited && !quotaExceeded && used / limit >= 0.85;
  const period = await resolvePlanPeriod(req.user.id);
  const upgradePlan = nextUpgradePlan(req.user.plan);

  res.json({
    month: new Date().toISOString().slice(0, 7),
    plan: req.user.plan,
    characters_used: used,
    characters_limit: unlimited ? null : limit,
    remaining,
    quota_exceeded: quotaExceeded,
    quota_warning: quotaWarning,
    upgrade_plan: upgradePlan,
    plan_period_end: period.plan_period_end,
    plan_period_label: period.plan_period_label,
    cancel_at_period_end: period.cancel_at_period_end,
    estimated_bill_usd: billing.total_usd,
    billing,
    stripe_enabled: isStripeEnabled(),
    payment_methods: ["card"],
    notification: quotaExceeded
      ? {
          level: "error",
          title: "Character quota exceeded",
          message:
            "You have used all characters on your current plan. Upgrade to continue translating.",
          action: upgradePlan ? `Upgrade to ${upgradePlan}` : "Contact support",
        }
      : quotaWarning
        ? {
            level: "warning",
            title: "Approaching quota limit",
            message: `You have used ${Math.round((used / limit) * 100)}% of your monthly characters.`,
            action: upgradePlan ? `Upgrade to ${upgradePlan}` : "Contact support",
          }
        : null,
    plans: Object.entries(PLAN_PRICES).map(([code, p]) => ({
      code,
      label: p.label,
      monthly_base_usd: p.base,
      overage_per_10k_usd: p.overagePer10k,
      character_limit: PLAN_LIMITS[code] === Number.MAX_SAFE_INTEGER ? null : PLAN_LIMITS[code],
    })),
  });
}

export async function usageHistory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const result = await query<{ day: string; characters: string; requests: string }>(
    `SELECT to_char(timestamp, 'YYYY-MM-DD') AS day,
            SUM(characters)::text AS characters,
            COUNT(*)::text AS requests
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
       AND timestamp < date_trunc('month', NOW()) + INTERVAL '1 month'
     GROUP BY 1
     ORDER BY 1`,
    [req.user.id]
  );

  res.json({
    month: new Date().toISOString().slice(0, 7),
    history: result.rows.map((r) => ({
      day: r.day,
      characters: parseInt(r.characters, 10),
      requests: parseInt(r.requests, 10),
    })),
  });
}

export async function getBillingMonth(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const month = String(req.params.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  const bill = await query<{
    month: string;
    characters_total: string;
    amount_usd: string;
    paid: boolean;
    paid_at: Date | null;
    stripe_session_id: string | null;
  }>(
    `SELECT month, characters_total::text, amount_usd::text, paid, paid_at, stripe_session_id
     FROM billing WHERE user_id = $1 AND month = $2`,
    [req.user.id, month]
  );

  const userStripe = await query<{ stripe_subscription_status: string | null }>(
    "SELECT stripe_subscription_status FROM users WHERE id = $1",
    [req.user.id]
  );
  const subStatus = userStripe.rows[0]?.stripe_subscription_status || null;

  if (!bill.rows[0]) {
    const computed = await computeUserBill(req.user.id, month, req.user.plan);
    const payable = payableAmountUsd(req.user.plan, computed.characters_total, subStatus);
    res.json({
      ...computed,
      payable_usd: payable.payable_usd,
      base_covered_by_subscription: payable.base_covered,
      stripe_enabled: isStripeEnabled(),
      payment_methods: ["card"],
    });
    return;
  }

  const row = bill.rows[0];
  const characters_total = parseInt(row.characters_total, 10);
  const payable = payableAmountUsd(req.user.plan, characters_total, subStatus);
  res.json({
    month: row.month,
    characters_total,
    plan: req.user.plan,
    amount_usd: parseFloat(row.amount_usd),
    payable_usd: row.paid ? 0 : payable.payable_usd,
    paid: row.paid,
    paid_at: row.paid_at?.toISOString() || null,
    base_covered_by_subscription: payable.base_covered,
    stripe_enabled: isStripeEnabled(),
    payment_methods: ["card"],
    billing: getBillingBreakdown(req.user.plan, characters_total),
  });
}

export async function getBillingHistory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const result = await query<{
    month: string;
    characters_total: string;
    amount_usd: string;
    paid: boolean;
    paid_at: Date | null;
    generated_at: Date;
  }>(
    `SELECT month, characters_total::text, amount_usd::text, paid, paid_at, generated_at
     FROM billing WHERE user_id = $1 ORDER BY month DESC`,
    [req.user.id]
  );

  const userStripe = await query<{ stripe_subscription_status: string | null }>(
    "SELECT stripe_subscription_status FROM users WHERE id = $1",
    [req.user.id]
  );
  const subStatus = userStripe.rows[0]?.stripe_subscription_status || null;

  res.json({
    stripe_enabled: isStripeEnabled(),
    payment_methods: ["card"],
    bills: result.rows.map((r) => {
      const chars = parseInt(r.characters_total, 10);
      const payable = payableAmountUsd(req.user!.plan, chars, subStatus);
      return {
        month: r.month,
        characters_total: chars,
        amount_usd: parseFloat(r.amount_usd),
        payable_usd: r.paid ? 0 : payable.payable_usd,
        paid: r.paid,
        paid_at: r.paid_at?.toISOString() || null,
        generated_at: r.generated_at.toISOString(),
      };
    }),
  });
}

export async function computeUserBill(
  userId: string,
  month: string,
  plan: string
): Promise<{
  month: string;
  characters_total: number;
  plan: string;
  amount_usd: number;
  paid: boolean;
  billing: BillingBreakdown;
}> {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));

  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total
     FROM usage_records
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp < $3`,
    [userId, start.toISOString(), end.toISOString()]
  );

  const characters_total = parseInt(result.rows[0].total, 10);
  const billing = getBillingBreakdown(plan, characters_total);

  return {
    month,
    characters_total,
    plan,
    amount_usd: billing.total_usd,
    paid: false,
    billing,
  };
}

export async function runMonthlyBilling(forMonth?: string): Promise<number> {
  const now = new Date();
  const month =
    forMonth ||
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);

  const users = await query<{ id: string; plan: string }>(
    "SELECT id, plan FROM users WHERE active = TRUE"
  );

  let count = 0;
  for (const user of users.rows) {
    const bill = await computeUserBill(user.id, month, user.plan);
    await query(
      `INSERT INTO billing (user_id, month, characters_total, amount_usd, paid)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (user_id, month) DO UPDATE
         SET characters_total = EXCLUDED.characters_total,
             amount_usd = EXCLUDED.amount_usd,
             generated_at = NOW()`,
      [user.id, month, bill.characters_total, bill.amount_usd]
    );
    count++;
  }
  return count;
}

export function startBillingCron(): void {
  // 1st of each month at 00:05 UTC — finalize previous month
  cron.schedule("5 0 1 * *", async () => {
    try {
      const n = await runMonthlyBilling();
      console.log(`[billing] Generated ${n} monthly bills`);
    } catch (err) {
      console.error("[billing] monthly cron failed:", err);
    }
  });

  // Daily at 02:00 UTC — refresh current-month estimates for all active users
  cron.schedule("0 2 * * *", async () => {
    try {
      const month = new Date().toISOString().slice(0, 7);
      const n = await runMonthlyBilling(month);
      console.log(`[billing] Refreshed ${n} current-month estimates`);
    } catch (err) {
      console.error("[billing] daily snapshot failed:", err);
    }
  });
}

/** Self-service plan upgrade — requires card payment via Stripe Checkout. */
export async function upgradePlan(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { plan } = req.body as { plan?: string };
  const allowed = ["starter", "business"];
  if (!plan || !allowed.includes(plan)) {
    res.status(400).json({
      error: `plan must be one of: ${allowed.join(", ")}`,
      hint: "Contact support@ugajapa.ac.ug for Enterprise",
    });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({
      error: "Plan upgrades require card payment — Stripe is not configured",
      hint: "Set STRIPE_SECRET_KEY to enable billing",
    });
    return;
  }

  const { createPlanCheckoutSession } = await import("./stripe_billing");
  await createPlanCheckoutSession(req, res);
}

export async function adminMarkBillPaid(
  req: Request,
  res: Response
): Promise<void> {
  const userId = String(req.params.user_id);
  const month = String(req.params.month || "");
  const { paid } = req.body as { paid?: boolean };

  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  const result = await query(
    `UPDATE billing SET paid = $1
     WHERE user_id = $2 AND month = $3
     RETURNING user_id, month, amount_usd, paid`,
    [paid !== false, userId, month]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: "Bill not found — run billing generation first" });
    return;
  }

  res.json({ message: "Bill updated", bill: result.rows[0] });
}

// --- Admin handlers ---

export async function adminUsers(_req: Request, res: Response): Promise<void> {
  const result = await query<{
    id: string;
    email: string;
    full_name: string;
    plan: string;
    active: boolean;
    created_at: Date;
    usage: string;
  }>(
    `SELECT u.id, u.email, u.full_name, u.plan, u.active, u.created_at,
            COALESCE(SUM(r.characters), 0)::text AS usage
     FROM users u
     LEFT JOIN usage_records r
       ON r.user_id = u.id
       AND r.timestamp >= date_trunc('month', NOW())
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  );

  res.json({
    users: result.rows.map((u) => ({
      user_id: u.id,
      email: u.email,
      full_name: u.full_name,
      plan: u.plan,
      active: u.active,
      created_at: u.created_at.toISOString(),
      characters_this_month: parseInt(u.usage, 10),
      plan_limit: PLAN_LIMITS[u.plan] ?? PLAN_LIMITS.free,
    })),
  });
}

export async function adminUsage(_req: Request, res: Response): Promise<void> {
  const result = await query<{
    total_chars: string;
    total_requests: string;
    users_active: string;
  }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total_chars,
            COUNT(*)::text AS total_requests,
            COUNT(DISTINCT user_id)::text AS users_active
     FROM usage_records
     WHERE timestamp >= date_trunc('month', NOW())`
  );

  const row = result.rows[0];
  res.json({
    month: new Date().toISOString().slice(0, 7),
    characters_total: parseInt(row.total_chars, 10),
    requests_total: parseInt(row.total_requests, 10),
    users_active: parseInt(row.users_active, 10),
  });
}

export async function adminUserUsage(req: Request, res: Response): Promise<void> {
  const { user_id } = req.params;
  const result = await query<{
    day: string;
    characters: string;
    requests: string;
    avg_quality: string | null;
  }>(
    `SELECT to_char(timestamp, 'YYYY-MM-DD') AS day,
            SUM(characters)::text AS characters,
            COUNT(*)::text AS requests,
            ROUND(AVG(quality_score)::numeric, 3)::text AS avg_quality
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
     GROUP BY 1
     ORDER BY 1`,
    [user_id]
  );

  res.json({
    user_id,
    month: new Date().toISOString().slice(0, 7),
    breakdown: result.rows.map((r) => ({
      day: r.day,
      characters: parseInt(r.characters, 10),
      requests: parseInt(r.requests, 10),
      avg_quality: r.avg_quality ? parseFloat(r.avg_quality) : null,
    })),
  });
}

export async function adminSetPlan(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { plan } = req.body as { plan?: string };
  const allowed = ["free", "starter", "business", "enterprise"];

  if (!plan || !allowed.includes(plan)) {
    res.status(400).json({ error: `plan must be one of: ${allowed.join(", ")}` });
    return;
  }

  // Self-serve paid tiers still need a payment marker so effectivePlan()
  // does not demote them. Admin grants are tagged explicitly (not card-paid).
  const subStatus =
    plan === "starter" || plan === "business" ? "admin_granted" : null;

  const result = await query(
    `UPDATE users
     SET plan = $1,
         stripe_subscription_status = $2,
         stripe_subscription_id = CASE WHEN $1 IN ('free') THEN NULL ELSE stripe_subscription_id END
     WHERE id = $3
     RETURNING id, email, plan, stripe_subscription_status`,
    [plan, subStatus, id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    message: "Plan updated",
    user: result.rows[0],
    note:
      plan === "starter" || plan === "business"
        ? "Admin grant — not a card payment. Customer self-serve upgrades still require Stripe Checkout."
        : undefined,
  });
}

export async function adminBillingSummary(req: Request, res: Response): Promise<void> {
  const month =
    (req.query.month as string) || new Date().toISOString().slice(0, 7);

  const result = await query<{
    bills: string;
    revenue: string;
    unpaid: string;
  }>(
    `SELECT COUNT(*)::text AS bills,
            COALESCE(SUM(amount_usd), 0)::text AS revenue,
            COALESCE(SUM(amount_usd) FILTER (WHERE paid = FALSE), 0)::text AS unpaid
     FROM billing WHERE month = $1`,
    [month]
  );

  const row = result.rows[0];
  res.json({
    month,
    bill_count: parseInt(row.bills, 10),
    revenue_usd: parseFloat(row.revenue),
    unpaid_usd: parseFloat(row.unpaid),
  });
}

export async function adminDeactivateUser(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = req.params;
  const result = await query(
    "UPDATE users SET active = FALSE WHERE id = $1 RETURNING id, email",
    [id]
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await query(
    "UPDATE api_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [id]
  );
  res.json({ message: "User deactivated", user: result.rows[0] });
}

export async function triggerBilling(req: Request, res: Response): Promise<void> {
  const secret = req.headers["x-billing-secret"];
  if (secret !== process.env.BILLING_CRON_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const month = (req.body as { month?: string }).month;
  const n = await runMonthlyBilling(month);
  res.json({ message: `Generated ${n} bills`, month: month || "previous" });
}
