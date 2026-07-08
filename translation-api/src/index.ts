import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { signup, login, logout, requireAuth, requireAdmin } from "./auth";
import { generateKey, listKeys, revokeKey, requireApiKey } from "./keys";
import {
  translateHandler,
  detectHandler,
  languagesHandler,
} from "./translate";
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
import { botHealth } from "./ugajapa-bot";
import { pool } from "./db";
import { seedAdmin, waitForDb } from "./seed";

const PORT = parseInt(process.env.PORT || "5000", 10);
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const translateLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const key = req.headers["x-api-key"];
    return (Array.isArray(key) ? key[0] : key) || req.ip || "unknown";
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
  const ok = dbOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    service: "ugajapa-translation-api",
    database: dbOk ? "up" : "down",
    bot: botOk ? "up" : "down",
  });
});

// Auth
app.post("/auth/signup", signup);
app.post("/auth/login", login);
app.post("/auth/logout", requireAuth, logout);

// API keys
app.post("/keys/generate", requireAuth, generateKey);
app.get("/keys", requireAuth, listKeys);
app.delete("/keys/:key_id", requireAuth, revokeKey);

// Translation (API key auth)
app.post("/translate", translateLimiter, requireApiKey, translateHandler);
app.post("/detect", translateLimiter, requireApiKey, detectHandler);
app.get("/languages", requireApiKey, languagesHandler);

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
