import Stripe from "stripe";
import { Request, Response } from "express";
import { query } from "./db";
import { getPlanLimit, PLAN_LIMITS, PLAN_PRICES } from "./usage";

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:5000";

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

export const PLAN_CATALOG = [
  {
    id: "free",
    name: "Free",
    price_usd: 0,
    characters: PLAN_LIMITS.free,
    description: "For testing and small projects",
    features: ["50K characters / month", "Quality scoring", "API keys"],
  },
  {
    id: "starter",
    name: "Starter",
    price_usd: PLAN_PRICES.starter.base,
    characters: PLAN_LIMITS.starter,
    description: "For growing teams and plugins",
    features: [
      "500K characters / month",
      "$0.50 per 10K overage",
      "Email support",
      "Card billing",
    ],
    stripe_price_env: "STRIPE_PRICE_STARTER",
  },
  {
    id: "business",
    name: "Business",
    price_usd: PLAN_PRICES.business.base,
    characters: PLAN_LIMITS.business,
    description: "For production workloads",
    features: [
      "5M characters / month",
      "$0.30 per 10K overage",
      "Priority support",
      "Card billing",
    ],
    stripe_price_env: "STRIPE_PRICE_BUSINESS",
  },
] as const;

function stripePriceId(plan: string): string | null {
  if (plan === "starter") return process.env.STRIPE_PRICE_STARTER || null;
  if (plan === "business") return process.env.STRIPE_PRICE_BUSINESS || null;
  return null;
}

async function getOrCreateCustomer(userId: string, email: string): Promise<string> {
  if (!stripe) throw new Error("Stripe is not configured");

  const existing = await query<{ stripe_customer_id: string | null }>(
    "SELECT stripe_customer_id FROM users WHERE id = $1",
    [userId]
  );
  if (existing.rows[0]?.stripe_customer_id) {
    return existing.rows[0].stripe_customer_id;
  }

  const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });
  await query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [
    customer.id,
    userId,
  ]);
  return customer.id;
}

export function billingConfig(_req: Request, res: Response): void {
  res.json({
    enabled: Boolean(stripe && STRIPE_PUBLISHABLE),
    publishable_key: STRIPE_PUBLISHABLE || null,
    payment_methods: ["card"],
    currency: "usd",
    plans: PLAN_CATALOG,
  });
}

export function listPlans(_req: Request, res: Response): void {
  res.json({ plans: PLAN_CATALOG });
}

export async function createPlanCheckout(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!stripe) {
    res.status(503).json({ error: "Card billing is not configured. Set STRIPE_SECRET_KEY." });
    return;
  }

  const { plan } = req.body as { plan?: string };
  if (!plan || !["starter", "business"].includes(plan)) {
    res.status(400).json({ error: "plan must be starter or business" });
    return;
  }

  const priceId = stripePriceId(plan);
  if (!priceId) {
    res.status(503).json({
      error: `Stripe price not configured for ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()}.`,
    });
    return;
  }

  const customerId = await getOrCreateCustomer(req.user.id, req.user.email);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${PORTAL_URL}/#/billing?checkout=success&plan=${plan}`,
    cancel_url: `${PORTAL_URL}/#/billing?checkout=canceled`,
    metadata: {
      type: "subscription",
      user_id: req.user.id,
      plan,
    },
  });

  res.json({ url: session.url, session_id: session.id });
}

export async function createInvoiceCheckout(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!stripe) {
    res.status(503).json({ error: "Card billing is not configured" });
    return;
  }

  const { month } = req.body as { month?: string };
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  const bill = await query<{
    amount_usd: string;
    paid: boolean;
    characters_total: string;
  }>(
    "SELECT amount_usd::text, paid, characters_total::text FROM billing WHERE user_id = $1 AND month = $2",
    [req.user.id, month]
  );

  if (!bill.rows[0]) {
    res.status(404).json({ error: "Invoice not found for this month" });
    return;
  }
  if (bill.rows[0].paid) {
    res.status(400).json({ error: "Invoice already paid" });
    return;
  }

  const amountUsd = parseFloat(bill.rows[0].amount_usd);
  if (amountUsd <= 0) {
    res.status(400).json({ error: "Nothing to pay for this invoice" });
    return;
  }

  const customerId = await getOrCreateCustomer(req.user.id, req.user.email);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(amountUsd * 100),
          product_data: {
            name: `UgaJapa Translation — ${month}`,
            description: `${bill.rows[0].characters_total} characters translated`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${PORTAL_URL}/#/billing?invoice_paid=${month}`,
    cancel_url: `${PORTAL_URL}/#/billing?checkout=canceled`,
    metadata: {
      type: "invoice",
      user_id: req.user.id,
      month,
    },
  });

  await query(
    "UPDATE billing SET stripe_session_id = $1 WHERE user_id = $2 AND month = $3",
    [session.id, req.user.id, month]
  );

  res.json({ url: session.url, session_id: session.id });
}

export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    res.status(503).send("Stripe webhook not configured");
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || Array.isArray(sig)) {
    res.status(400).send("Missing stripe-signature");
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err);
    res.status(400).send("Invalid signature");
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      const type = session.metadata?.type;

      if (!userId) {
        res.json({ received: true });
        return;
      }

      if (type === "subscription" && session.metadata?.plan) {
        const plan = session.metadata.plan;
        if (["starter", "business"].includes(plan)) {
          await query("UPDATE users SET plan = $1 WHERE id = $2", [plan, userId]);
        }
      }

      if (type === "invoice" && session.metadata?.month) {
        await query(
          `UPDATE billing SET paid = TRUE, stripe_payment_intent_id = $1
           WHERE user_id = $2 AND month = $3`,
          [session.payment_intent || session.id, userId, session.metadata.month]
        );
      }
    }
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    res.status(500).send("Webhook handler failed");
    return;
  }

  res.json({ received: true });
}

export async function billingOverview(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = getPlanLimit(req.user.plan);
  const usage = await query<{ total: string }>(
    `SELECT COALESCE(SUM(characters), 0)::text AS total
     FROM usage_records
     WHERE user_id = $1
       AND timestamp >= date_trunc('month', NOW())
       AND timestamp < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [req.user.id]
  );

  const invoices = await query<{
    month: string;
    characters_total: string;
    amount_usd: string;
    paid: boolean;
  }>(
    `SELECT month, characters_total::text, amount_usd::text, paid
     FROM billing WHERE user_id = $1 ORDER BY month DESC LIMIT 12`,
    [req.user.id]
  );

  const used = parseInt(usage.rows[0].total, 10);

  res.json({
    plan: req.user.plan,
    stripe_enabled: Boolean(stripe && STRIPE_PUBLISHABLE),
    usage: {
      month: new Date().toISOString().slice(0, 7),
      characters_used: used,
      characters_limit: limit === Number.MAX_SAFE_INTEGER ? null : limit,
      remaining: limit === Number.MAX_SAFE_INTEGER ? null : Math.max(0, limit - used),
    },
    invoices: invoices.rows.map((r) => ({
      month: r.month,
      characters_total: parseInt(r.characters_total, 10),
      amount_usd: parseFloat(r.amount_usd),
      paid: r.paid,
    })),
    plans: PLAN_CATALOG,
  });
}
