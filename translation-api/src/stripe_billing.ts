import { Request, Response } from "express";
import Stripe from "stripe";
import { query } from "./db";
import {
  getBillingBreakdown,
  PLAN_ORDER,
  PLAN_PRICES,
  monthQuotaResetAt,
} from "./usage";

/** Card payments only — no bank transfer, wallets, or other methods. */
const CARD_ONLY: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] = ["card"];

let stripeClient: Stripe | null = null;

/** Strip accidental duplicated prefixes like sk_test_sk_test_... */
function normalizeStripeKey(raw: string | undefined, kind: "secret" | "publishable" | "webhook"): string {
  let key = (raw || "").trim();
  if (!key) return "";

  if (kind === "secret") {
    while (key.startsWith("sk_test_sk_test_")) key = key.slice("sk_test_".length);
    while (key.startsWith("sk_live_sk_live_")) key = key.slice("sk_live_".length);
  } else if (kind === "publishable") {
    while (key.startsWith("pk_test_pk_test_")) key = key.slice("pk_test_".length);
    while (key.startsWith("pk_live_pk_live_")) key = key.slice("pk_live_".length);
  } else if (kind === "webhook") {
    // Common mistake: whsec_sk_test_... (API key used as webhook secret)
    if (key.startsWith("whsec_sk_") || key.startsWith("whsec_pk_")) {
      return "";
    }
  }
  return key;
}

function stripeSecretKey(): string {
  return normalizeStripeKey(process.env.STRIPE_SECRET_KEY, "secret");
}

export function isStripeEnabled(): boolean {
  return Boolean(stripeSecretKey());
}

export function getStripe(): Stripe {
  const secret = stripeSecretKey();
  if (!secret) {
    throw new Error("Stripe is not configured — set STRIPE_SECRET_KEY");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(secret, {
      typescript: true,
    });
  }
  return stripeClient;
}

function stripeErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "type" in err) {
    const s = err as Stripe.errors.StripeError;
    if (s.type === "StripeAuthenticationError") {
      return "Invalid Stripe API key — check STRIPE_SECRET_KEY in your environment (use the full sk_test_… key from the Stripe Dashboard, without duplicating the prefix)";
    }
    if (s.message) return s.message;
  }
  if (err instanceof Error) return err.message;
  return "Stripe request failed";
}

function appBaseUrl(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = req.get("host") || "localhost:5000";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}`;
}

type DbUser = {
  id: string;
  email: string;
  full_name: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
};

async function loadUser(userId: string): Promise<DbUser | null> {
  const result = await query<DbUser>(
    `SELECT id, email, full_name, plan, stripe_customer_id,
            stripe_subscription_id, stripe_subscription_status
     FROM users WHERE id = $1 AND active = TRUE`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function ensureStripeCustomer(user: DbUser): Promise<string> {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.full_name,
    metadata: { user_id: user.id },
  });

  await query(
    "UPDATE users SET stripe_customer_id = $1 WHERE id = $2",
    [customer.id, user.id]
  );

  return customer.id;
}

function planMonthlyCents(plan: string): number {
  const pricing = PLAN_PRICES[plan];
  if (!pricing || pricing.base <= 0) {
    throw new Error(`Plan ${plan} does not require a paid subscription`);
  }
  return Math.round(pricing.base * 100);
}

function assertUpgradeAllowed(currentPlan: string, targetPlan: string): void {
  const currentIdx = PLAN_ORDER.indexOf(currentPlan as (typeof PLAN_ORDER)[number]);
  const targetIdx = PLAN_ORDER.indexOf(targetPlan as (typeof PLAN_ORDER)[number]);
  if (targetIdx <= currentIdx) {
    throw new Error("You can only upgrade to a higher plan");
  }
  if (targetPlan === "enterprise") {
    throw new Error("Contact support@ugajapa.ac.ug for Enterprise");
  }
  if (!["starter", "business"].includes(targetPlan)) {
    throw new Error("Invalid plan for card checkout");
  }
}

/** Amount due for a bill — base is covered by an active subscription. */
export function payableAmountUsd(
  plan: string,
  charactersTotal: number,
  subscriptionStatus: string | null
): { payable_usd: number; base_covered: boolean; breakdown: ReturnType<typeof getBillingBreakdown> } {
  const breakdown = getBillingBreakdown(plan, charactersTotal);
  const baseCovered = subscriptionStatus === "active" && breakdown.base_usd > 0;
  const payable = baseCovered ? breakdown.overage_usd : breakdown.total_usd;
  return {
    payable_usd: Number(payable.toFixed(2)),
    base_covered: baseCovered,
    breakdown,
  };
}

export async function createPlanCheckoutSession(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { plan } = req.body as { plan?: string };
  if (!plan || !["starter", "business"].includes(plan)) {
    res.status(400).json({
      error: "plan must be starter or business",
      hint: "Contact support@ugajapa.ac.ug for Enterprise",
    });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({
      error: "Card payments are not configured",
      hint: "Set STRIPE_SECRET_KEY to enable billing",
    });
    return;
  }

  const user = await loadUser(req.user.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    assertUpgradeAllowed(user.plan, plan);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid upgrade",
      current_plan: user.plan,
    });
    return;
  }

  const stripe = getStripe();
  let customerId: string;
  try {
    customerId = await ensureStripeCustomer(user);
  } catch (err) {
    console.error("[stripe] ensure customer failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
    return;
  }

  if (user.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(user.stripe_subscription_id);
    } catch (err) {
      console.warn("[stripe] could not cancel previous subscription:", err);
    }
  }

  const base = appBaseUrl(req);
  const pricing = PLAN_PRICES[plan];

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      payment_method_types: CARD_ONLY,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `UgaJapa ${pricing.label} Plan`,
              description: `${pricing.label} monthly subscription — card payment only`,
            },
            unit_amount: planMonthlyCents(plan),
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "plan_subscription",
        user_id: user.id,
        plan,
      },
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan,
        },
      },
      success_url: `${base}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?billing=cancelled`,
    });

    res.json({
      checkout_url: session.url,
      session_id: session.id,
      payment_method: "card",
      message: "Redirect to Stripe Checkout to pay by card",
    });
  } catch (err) {
    console.error("[stripe] plan checkout failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
  }
}

export async function createInvoiceCheckoutSession(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { month } = req.body as { month?: string };
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({
      error: "Card payments are not configured",
      hint: "Set STRIPE_SECRET_KEY to enable billing",
    });
    return;
  }

  const user = await loadUser(req.user.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const billRow = await query<{
    characters_total: string;
    amount_usd: string;
    paid: boolean;
  }>(
    `SELECT characters_total::text, amount_usd::text, paid
     FROM billing WHERE user_id = $1 AND month = $2`,
    [user.id, month]
  );

  let charactersTotal: number;
  let amountUsd: number;
  let paid: boolean;

  if (billRow.rows[0]) {
    charactersTotal = parseInt(billRow.rows[0].characters_total, 10);
    amountUsd = parseFloat(billRow.rows[0].amount_usd);
    paid = billRow.rows[0].paid;
  } else {
    const { computeUserBill } = await import("./billing");
    const computed = await computeUserBill(user.id, month, user.plan);
    charactersTotal = computed.characters_total;
    amountUsd = computed.amount_usd;
    paid = computed.paid;
  }

  if (paid) {
    res.status(400).json({ error: "This invoice is already paid", month });
    return;
  }

  const { payable_usd, base_covered, breakdown } = payableAmountUsd(
    user.plan,
    charactersTotal,
    user.stripe_subscription_status
  );

  if (payable_usd <= 0) {
    res.status(400).json({
      error: "Nothing to pay for this period",
      month,
      base_covered,
    });
    return;
  }

  const stripe = getStripe();
  const base = appBaseUrl(req);

  const description = base_covered
    ? `Overage charges for ${month} (${breakdown.overage_characters.toLocaleString()} chars)`
    : `Usage charges for ${month}`;

  try {
    const customerId = await ensureStripeCustomer(user);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      payment_method_types: CARD_ONLY,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `UgaJapa Invoice — ${month}`,
              description,
            },
            unit_amount: Math.round(payable_usd * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "monthly_invoice",
        user_id: user.id,
        month,
        payable_usd: String(payable_usd),
      },
      success_url: `${base}/?billing=paid&month=${month}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?billing=cancelled`,
    });

    res.json({
      checkout_url: session.url,
      session_id: session.id,
      month,
      payable_usd,
      base_covered,
      payment_method: "card",
      message: "Redirect to Stripe Checkout to pay by card",
    });
  } catch (err) {
    console.error("[stripe] invoice checkout failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
  }
}

export async function createBillingPortalSession(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({ error: "Card payments are not configured" });
    return;
  }

  const user = await loadUser(req.user.id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const customerId = await ensureStripeCustomer(user);
    const stripe = getStripe();
    const base = appBaseUrl(req);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${base}/?settings=billing`,
    });

    res.json({
      portal_url: session.url,
      payment_method: "card",
      message: "Manage cards and subscriptions — card payments only",
    });
  } catch (err) {
    console.error("[stripe] billing portal failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
  }
}

export async function getBillingConfig(_req: Request, res: Response): Promise<void> {
  res.json({
    stripe_enabled: isStripeEnabled(),
    payment_methods: ["card"],
    card_only: true,
    publishable_key: normalizeStripeKey(process.env.STRIPE_PUBLISHABLE_KEY, "publishable") || null,
    plans: Object.entries(PLAN_PRICES)
      .filter(([code]) => code !== "enterprise")
      .map(([code, p]) => ({
        code,
        label: p.label,
        monthly_base_usd: p.base,
        overage_per_10k_usd: p.overagePer10k,
      })),
  });
}

export async function getCheckoutSessionStatus(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const sessionId = String(req.query.session_id || "");
  if (!sessionId) {
    res.status(400).json({ error: "session_id is required" });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({ error: "Stripe is not configured" });
    return;
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.user_id !== req.user.id) {
      res.status(403).json({ error: "Session does not belong to this account" });
      return;
    }

    res.json({
      session_id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      type: session.metadata?.type || null,
      plan: session.metadata?.plan || null,
      month: session.metadata?.month || null,
    });
  } catch (err) {
    console.error("[stripe] session status failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
  }
}

/**
 * Apply a completed Checkout session to the user account.
 * Used on success redirect so local/dev works without Stripe webhooks.
 */
export async function confirmCheckoutSession(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { session_id: sessionId } = req.body as { session_id?: string };
  if (!sessionId) {
    res.status(400).json({ error: "session_id is required" });
    return;
  }

  if (!isStripeEnabled()) {
    res.status(503).json({ error: "Stripe is not configured" });
    return;
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.user_id !== req.user.id) {
      res.status(403).json({ error: "Session does not belong to this account" });
      return;
    }

    const paid =
      session.payment_status === "paid" ||
      session.status === "complete";

    if (!paid) {
      res.status(402).json({
        error: "Payment not completed yet",
        status: session.status,
        payment_status: session.payment_status,
      });
      return;
    }

    await handleCheckoutCompleted(session);

    const user = await loadUser(req.user.id);
    res.json({
      message: "Payment confirmed — plan updated",
      session_id: session.id,
      type: session.metadata?.type || null,
      plan: user?.plan || session.metadata?.plan || null,
      stripe_subscription_status: user?.stripe_subscription_status || null,
      payment_status: session.payment_status,
    });
  } catch (err) {
    console.error("[stripe] confirm checkout failed:", err);
    res.status(502).json({ error: stripeErrorMessage(err) });
  }
}

async function applyPlanSubscription(
  userId: string,
  plan: string,
  subscriptionId: string | null,
  status: string,
  currentPeriodEnd?: Date | null
): Promise<void> {
  await query(
    `UPDATE users
     SET plan = $1,
         stripe_subscription_id = $2,
         stripe_subscription_status = $3,
         stripe_current_period_end = COALESCE($4, stripe_current_period_end)
     WHERE id = $5`,
    [plan, subscriptionId, status, currentPeriodEnd ?? null, userId]
  );
}

/** Resolve when the plan/quota period ends (renews, expires, or monthly reset). */
export async function resolvePlanPeriod(userId: string): Promise<{
  plan_period_end: string | null;
  plan_period_label: "renews" | "expires" | "resets";
  cancel_at_period_end: boolean;
}> {
  const result = await query<{
    plan: string;
    stripe_subscription_id: string | null;
    stripe_subscription_status: string | null;
    stripe_current_period_end: Date | null;
  }>(
    `SELECT plan, stripe_subscription_id, stripe_subscription_status, stripe_current_period_end
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    return {
      plan_period_end: monthQuotaResetAt().toISOString(),
      plan_period_label: "resets",
      cancel_at_period_end: false,
    };
  }

  let periodEnd = user.stripe_current_period_end;
  let cancelAtPeriodEnd = false;

  if (
    user.stripe_subscription_id &&
    isStripeEnabled() &&
    (user.stripe_subscription_status === "active" ||
      user.stripe_subscription_status === "trialing")
  ) {
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
      periodEnd = new Date(sub.current_period_end * 1000);
      cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
      await query(
        `UPDATE users SET stripe_current_period_end = $1 WHERE id = $2`,
        [periodEnd, userId]
      );
    } catch (err) {
      console.warn("[stripe] could not refresh subscription period:", err);
    }
  }

  if (
    periodEnd &&
    (user.plan === "starter" || user.plan === "business") &&
    (user.stripe_subscription_status === "active" ||
      user.stripe_subscription_status === "trialing" ||
      user.stripe_subscription_status === "admin_granted")
  ) {
    return {
      plan_period_end: periodEnd.toISOString(),
      plan_period_label: cancelAtPeriodEnd ? "expires" : "renews",
      cancel_at_period_end: cancelAtPeriodEnd,
    };
  }

  // Free / unpaid: monthly character quota resets.
  return {
    plan_period_end: monthQuotaResetAt().toISOString(),
    plan_period_label: "resets",
    cancel_at_period_end: false,
  };
}

async function markInvoicePaid(
  userId: string,
  month: string,
  sessionId: string,
  paymentIntentId: string | null
): Promise<void> {
  await query(
    `INSERT INTO billing (user_id, month, characters_total, amount_usd, paid,
                          stripe_session_id, stripe_payment_intent_id, paid_at)
     SELECT $1, $2,
            COALESCE((SELECT characters_total FROM billing WHERE user_id = $1 AND month = $2), 0),
            COALESCE((SELECT amount_usd FROM billing WHERE user_id = $1 AND month = $2), 0),
            TRUE, $3, $4, NOW()
     ON CONFLICT (user_id, month) DO UPDATE
       SET paid = TRUE,
           stripe_session_id = EXCLUDED.stripe_session_id,
           stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
           paid_at = NOW()`,
    [userId, month, sessionId, paymentIntentId]
  );
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const type = session.metadata?.type;
  const userId = session.metadata?.user_id;
  if (!userId) return;

  if (type === "plan_subscription") {
    const plan = session.metadata?.plan;
    if (!plan) return;
    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id || null;
    let periodEnd: Date | null = null;
    if (subId && isStripeEnabled()) {
      try {
        const sub = await getStripe().subscriptions.retrieve(subId);
        periodEnd = new Date(sub.current_period_end * 1000);
      } catch (err) {
        console.warn("[stripe] could not load subscription period:", err);
      }
    }
    await applyPlanSubscription(userId, plan, subId, "active", periodEnd);
    return;
  }

  if (type === "monthly_invoice") {
    const month = session.metadata?.month;
    if (!month) return;
    const pi =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null;
    await markInvoicePaid(userId, month, session.id, pi);
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const userId = subscription.metadata?.user_id;
  if (!userId) return;

  const plan = subscription.metadata?.plan;
  const status = subscription.status;

  if (status === "active" || status === "trialing") {
    const periodEnd = new Date(subscription.current_period_end * 1000);
    if (plan) {
      await applyPlanSubscription(userId, plan, subscription.id, status, periodEnd);
    } else {
      await query(
        `UPDATE users
         SET stripe_subscription_id = $1,
             stripe_subscription_status = $2,
             stripe_current_period_end = $3
         WHERE id = $4`,
        [subscription.id, status, periodEnd, userId]
      );
    }
    return;
  }

  if (status === "canceled" || status === "unpaid" || status === "past_due") {
    await query(
      `UPDATE users
       SET stripe_subscription_status = $1,
           plan = CASE WHEN $1 IN ('canceled', 'unpaid') THEN 'free' ELSE plan END,
           stripe_subscription_id = CASE WHEN $1 = 'canceled' THEN NULL ELSE stripe_subscription_id END,
           stripe_current_period_end = CASE WHEN $1 = 'canceled' THEN NULL ELSE stripe_current_period_end END
       WHERE id = $2`,
      [status, userId]
    );
  }
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  if (!isStripeEnabled()) {
    res.status(503).json({ error: "Stripe is not configured" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || Array.isArray(sig)) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  const secret = normalizeStripeKey(process.env.STRIPE_WEBHOOK_SECRET, "webhook");
  if (!secret) {
    res.status(503).json({ error: "STRIPE_WEBHOOK_SECRET is not configured (use the whsec_… value from `stripe listen` or the Stripe Dashboard webhook)" });
    return;
  }

  const stripe = getStripe();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[stripe] webhook signature verification failed:", err);
    res.status(400).json({ error: "Invalid webhook signature" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subMeta = invoice.subscription_details?.metadata;
        const userId = subMeta?.user_id || invoice.metadata?.user_id;
        if (userId && invoice.billing_reason === "subscription_create") {
          const plan = subMeta?.plan || invoice.metadata?.plan;
          const subId =
            typeof invoice.subscription === "string"
              ? invoice.subscription
              : invoice.subscription?.id || null;
          if (plan) {
            await applyPlanSubscription(userId, plan, subId, "active");
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[stripe] webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
    return;
  }

  res.json({ received: true });
}
