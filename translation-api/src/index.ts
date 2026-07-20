import path from "path";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import {
  signup,
  login,
  logout,
  me,
  verifyEmail,
  resendVerificationCode,
  requireAuth,
  requireAdmin,
} from "./auth";
import { adminLoginActivity, adminUserLoginActivity } from "./login_tracking";
import {
  generateKey,
  listKeys,
  revokeKey,
  requireApiKey,
  adminListUserKeys,
  adminRevokeKey,
} from "./keys";
import {
  translateHandler,
  detectHandler,
  languagesHandler,
  dashboardTranslateHandler,
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
  adminMarkBillPaid,
  triggerBilling,
  upgradePlan,
} from "./billing";
import {
  createPlanCheckoutSession,
  createInvoiceCheckoutSession,
  createBillingPortalSession,
  getBillingConfig,
  getCheckoutSessionStatus,
  confirmCheckoutSession,
  handleStripeWebhook,
  isStripeEnabled,
} from "./stripe_billing";
import { botHealth } from "./ugajapa-bot";
import { pool } from "./db";
import { ensureSchema, seedAdmin, waitForDb } from "./seed";
import { getSpeechEngine } from "./stt";
import { isGoogleSpeechEnabled } from "./google_speech";
import { isGoogleTTSEnabled } from "./google_tts";
import { isGroqWhisperEnabled } from "./groq_whisper";
import { isAiQualityEnabled } from "./quality_eval";
import { getTranslationCacheStats } from "./translation_cache";
import {
  MAX_MEDIA_BYTES,
  transcribeHandler,
  synthesizeHandler,
  audioTranslateHandler,
  videoTranslateHandler,
  documentTranslateHandler,
} from "./media";

const PORT = parseInt(process.env.PORT || "5000", 10);
const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy — without this,
// req.ip always resolves to the proxy's internal address, not the real
// client IP, which breaks both rate limiting and login/session tracking.
app.set("trust proxy", 1);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES },
});

/**
 * Express 4 does not forward rejected promises from async handlers to the
 * error middleware — an uncaught rejection becomes an unhandled rejection
 * that crashes the whole process. Wrap every async handler so failures
 * become a normal 500 response instead of taking the API down.
 */
function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.use(cors());

// Stripe webhooks require the raw body for signature verification.
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(handleStripeWebhook)
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
    return (Array.isArray(key) ? key[0] : key) || req.ip || "unknown";
  },
  message: { error: "Rate limit exceeded — max 10 requests/second per API key" },
});

// Throttle auth endpoints per IP to slow down credential stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a few minutes and try again" },
});

app.get(
  "/health",
  asyncHandler(async (_req, res) => {
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
      speech_engine: getSpeechEngine(),
      google_speech: isGoogleSpeechEnabled(),
      google_translate: Boolean(process.env.GOOGLE_API_KEY?.trim()),
      google_tts: isGoogleTTSEnabled(),
      groq_llm: Boolean(process.env.GROQ_API_KEY?.trim()),
      groq_model: "llama-3.3-70b-versatile",
      groq_whisper: isGroqWhisperEnabled(),
      groq_whisper_model:
        process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
      quality_ai: isAiQualityEnabled(),
      translation_cache: getTranslationCacheStats(),
      stripe_enabled: isStripeEnabled(),
      payment_methods: ["card"],
    });
  })
);

// Auth
app.post("/auth/signup", authLimiter, asyncHandler(signup));
app.post("/auth/verify", authLimiter, asyncHandler(verifyEmail));
app.post("/auth/verify/resend", authLimiter, asyncHandler(resendVerificationCode));
app.post("/auth/login", authLimiter, asyncHandler(login));
app.post("/auth/logout", asyncHandler(requireAuth), asyncHandler(logout));
app.get("/auth/me", asyncHandler(requireAuth), asyncHandler(me));

// API keys
app.post("/keys/generate", asyncHandler(requireAuth), asyncHandler(generateKey));
app.get("/keys", asyncHandler(requireAuth), asyncHandler(listKeys));
app.delete("/keys/:key_id", asyncHandler(requireAuth), asyncHandler(revokeKey));

// Translation (API key auth)
app.post(
  "/translate",
  translateLimiter,
  asyncHandler(requireApiKey),
  asyncHandler(translateHandler)
);
app.post(
  "/detect",
  translateLimiter,
  asyncHandler(requireApiKey),
  asyncHandler(detectHandler)
);
app.get("/languages", asyncHandler(requireApiKey), asyncHandler(languagesHandler));

// Speech — voice notes, read-aloud, video subtitles
app.post(
  "/transcribe",
  translateLimiter,
  asyncHandler(requireApiKey),
  upload.single("audio"),
  asyncHandler(transcribeHandler)
);
app.post(
  "/synthesize",
  translateLimiter,
  asyncHandler(requireApiKey),
  asyncHandler(synthesizeHandler)
);
app.post(
  "/audio/translate",
  translateLimiter,
  asyncHandler(requireApiKey),
  upload.single("file"),
  asyncHandler(audioTranslateHandler)
);
app.post(
  "/video/translate",
  translateLimiter,
  asyncHandler(requireApiKey),
  upload.single("file"),
  asyncHandler(videoTranslateHandler)
);
app.post(
  "/document/translate",
  translateLimiter,
  asyncHandler(requireApiKey),
  upload.single("file"),
  asyncHandler(documentTranslateHandler)
);

// Usage & billing
app.get("/usage/summary", asyncHandler(requireAuth), asyncHandler(usageSummary));
app.get("/usage/history", asyncHandler(requireAuth), asyncHandler(usageHistory));
app.get("/billing/config", asyncHandler(getBillingConfig));
app.get("/billing/checkout/status", asyncHandler(requireAuth), asyncHandler(getCheckoutSessionStatus));
app.post("/billing/checkout/confirm", asyncHandler(requireAuth), asyncHandler(confirmCheckoutSession));
app.get("/billing", asyncHandler(requireAuth), asyncHandler(getBillingHistory));
app.get("/billing/:month", asyncHandler(requireAuth), asyncHandler(getBillingMonth));
app.post("/billing/plan", asyncHandler(requireAuth), asyncHandler(upgradePlan));
app.post("/billing/checkout/plan", asyncHandler(requireAuth), asyncHandler(createPlanCheckoutSession));
app.post("/billing/checkout/invoice", asyncHandler(requireAuth), asyncHandler(createInvoiceCheckoutSession));
app.post("/billing/portal", asyncHandler(requireAuth), asyncHandler(createBillingPortalSession));

// Dashboard (JWT — for the web UI at /)
app.get("/dashboard/languages", asyncHandler(requireAuth), asyncHandler(languagesHandler));
app.post(
  "/dashboard/translate",
  translateLimiter,
  asyncHandler(requireAuth),
  asyncHandler(dashboardTranslateHandler)
);
app.post("/internal/billing/run", asyncHandler(triggerBilling));

// Admin
app.get("/admin/users", asyncHandler(requireAdmin), asyncHandler(adminUsers));
app.get("/admin/usage", asyncHandler(requireAdmin), asyncHandler(adminUsage));
app.get(
  "/admin/usage/:user_id",
  asyncHandler(requireAdmin),
  asyncHandler(adminUserUsage)
);
app.post(
  "/admin/users/:id/plan",
  asyncHandler(requireAdmin),
  asyncHandler(adminSetPlan)
);
app.get(
  "/admin/billing/summary",
  asyncHandler(requireAdmin),
  asyncHandler(adminBillingSummary)
);
app.post(
  "/admin/billing/:user_id/:month/paid",
  asyncHandler(requireAdmin),
  asyncHandler(adminMarkBillPaid)
);
app.get("/admin/logins", asyncHandler(requireAdmin), asyncHandler(adminLoginActivity));
app.get(
  "/admin/users/:user_id/keys",
  asyncHandler(requireAdmin),
  asyncHandler(adminListUserKeys)
);
app.delete(
  "/admin/keys/:key_id",
  asyncHandler(requireAdmin),
  asyncHandler(adminRevokeKey)
);
app.get(
  "/admin/users/:user_id/logins",
  asyncHandler(requireAdmin),
  asyncHandler(adminUserLoginActivity)
);
app.delete(
  "/admin/users/:id",
  asyncHandler(requireAdmin),
  asyncHandler(adminDeactivateUser)
);

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
  await ensureSchema();
  await seedAdmin();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`UgaJapa Translation API listening on port ${PORT}`);
    startBillingCron();
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
