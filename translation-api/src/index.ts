import express from "express";
import cors from "cors";
import path from "path";
import rateLimit from "express-rate-limit";
import { signup, login, logout, requireAuth, requireAdmin, getMe } from "./auth";
import { generateKey, listKeys, revokeKey, requireApiKey } from "./keys";
import {
  translateHandler,
  detectHandler,
  languagesHandler,
  deliverHandler,
  evaluateHandler,
  v1TranslateHandler,
  v1LanguagesHandler,
} from "./translate";
import { feedbackHandler } from "./feedback";
import { apiKeyUsage } from "./usage";
import {
  usageSummary,
  usageHistory,
  getBillingMonth,
  getBillingHistory,
  startBillingCron,
  adminUsers,
  adminUsage,
  adminUserUsage,
  adminSetPlan,
  adminBillingSummary,
  adminDeactivateUser,
  triggerBilling,
} from "./billing";
import {
  billingConfig,
  billingOverview,
  createInvoiceCheckout,
  createPlanCheckout,
  listPlans,
  stripeWebhook,
} from "./stripe-billing";
import { botHealth } from "./ugajapa-bot";
import { pool } from "./db";
import { seedAdmin, waitForDb } from "./seed";

const PORT = parseInt(process.env.PORT || "5000", 10);
const app = express();

app.use(cors());

// Stripe webhook must receive raw body
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const translateLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const key = req.headers["x-api-key"];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null;
    return (Array.isArray(key) ? key[0] : key) || bearer || req.ip || "unknown";
  },
  message: { error: "Rate limit exceeded — max 10 requests/second per API key" },
});

app.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const botOk = await botHealth();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    service: "ugajapa-translation-api",
    version: "1.0.0",
    database: dbOk ? "up" : "down",
    bot: botOk ? "up" : "down",
  });
});

// Auth
app.post("/auth/signup", signup);
app.post("/auth/register", signup);
app.post("/auth/login", login);
app.post("/auth/logout", requireAuth, logout);
app.get("/auth/me", requireAuth, getMe);

// API keys
app.post("/keys/generate", requireAuth, generateKey);
app.get("/keys", requireAuth, listKeys);
app.delete("/keys/:key_id", requireAuth, revokeKey);

// Plugin routes
app.post("/translate", translateLimiter, requireApiKey, translateHandler);
app.post("/translate/deliver", translateLimiter, requireApiKey, deliverHandler);
app.post("/translate/evaluate", translateLimiter, requireApiKey, evaluateHandler);
app.post("/detect", translateLimiter, requireApiKey, detectHandler);
app.get("/languages", requireApiKey, languagesHandler);

// v1 API
app.post("/v1/translate", translateLimiter, requireApiKey, v1TranslateHandler);
app.get("/v1/languages", requireApiKey, v1LanguagesHandler);
app.get("/v1/usage", requireApiKey, apiKeyUsage);
app.post("/v1/feedback", requireApiKey, feedbackHandler);

// Portal
app.get("/dashboard/usage", requireAuth, usageSummary);
app.get("/dashboard/invoices", requireAuth, getBillingHistory);
app.get("/billing/config", billingConfig);
app.get("/billing/plans", listPlans);
app.get("/billing/overview", requireAuth, billingOverview);
app.post("/billing/checkout/plan", requireAuth, createPlanCheckout);
app.post("/billing/checkout/invoice", requireAuth, createInvoiceCheckout);

// Usage & billing
app.get("/usage/summary", requireAuth, usageSummary);
app.get("/usage/history", requireAuth, usageHistory);
app.get("/billing/:month", requireAuth, getBillingMonth);
app.get("/billing", requireAuth, getBillingHistory);
app.post("/internal/billing/run", triggerBilling);

// Admin
app.get("/admin/users", requireAdmin, adminUsers);
app.get("/admin/usage", requireAdmin, adminUsage);
app.get("/admin/usage/:user_id", requireAdmin, adminUserUsage);
app.post("/admin/users/:id/plan", requireAdmin, adminSetPlan);
app.get("/admin/billing/summary", requireAdmin, adminBillingSummary);
app.delete("/admin/users/:id", requireAdmin, adminDeactivateUser);

// SPA fallback
app.get(["/", "/login", "/signup", "/dashboard", "/billing", "/keys"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

async function start() {
  await waitForDb();
  await seedAdmin();
  app.listen(PORT, () => {
    console.log(`UgaJapa Translation API listening on port ${PORT}`);
    startBillingCron();
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
