import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query } from "./db";
import { sendVerificationEmail } from "./mailer";
import { recordLoginEvent } from "./login_tracking";
import { effectivePlan } from "./usage";

const VERIFICATION_CODE_TTL_MINUTES = 15;
const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

function generateVerificationCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Basic real-looking-email check — not exhaustive RFC 5322, just filters out junk. */
function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email);
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES = "24h";

export type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  plan: string;
  isAdmin?: boolean;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      jti?: string;
    }
  }
}

type JwtPayload = {
  sub: string;
  email: string;
  full_name: string;
  plan: string;
  jti: string;
  isAdmin?: boolean;
};

export function signToken(user: AuthUser): string {
  const jti = uuidv4();
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      full_name: user.full_name,
      plan: user.plan,
      jti,
      isAdmin: user.isAdmin || false,
    } satisfies JwtPayload,
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const revoked = await query(
      "SELECT 1 FROM revoked_tokens WHERE jti = $1",
      [decoded.jti]
    );
    if (revoked.rowCount && revoked.rowCount > 0) {
      res.status(401).json({ error: "Token has been revoked" });
      return;
    }

    if (decoded.isAdmin) {
      const adminResult = await query<{ id: string; email: string }>(
        "SELECT id, email FROM admins WHERE id = $1",
        [decoded.sub]
      );
      if (!adminResult.rows[0]) {
        res.status(401).json({ error: "Admin not found" });
        return;
      }
      const a = adminResult.rows[0];
      req.user = {
        id: a.id,
        email: a.email,
        full_name: "Admin",
        plan: "enterprise",
        isAdmin: true,
      };
      req.jti = decoded.jti;
      next();
      return;
    }

    const userResult = await query<{
      id: string;
      email: string;
      full_name: string;
      plan: string;
      active: boolean;
      stripe_subscription_status: string | null;
    }>(
      `SELECT id, email, full_name, plan, active, stripe_subscription_status
       FROM users WHERE id = $1`,
      [decoded.sub]
    );

    if (!userResult.rows[0] || !userResult.rows[0].active) {
      res.status(401).json({ error: "User not found or inactive" });
      return;
    }

    const u = userResult.rows[0];
    req.user = {
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      plan: effectivePlan(u.plan, u.stripe_subscription_status),
      isAdmin: false,
    };
    req.jti = decoded.jti;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  await requireAuth(req, res, () => {
    if (!req.user?.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
}

export async function signup(req: Request, res: Response): Promise<void> {
  const { email, password, full_name } = req.body as {
    email?: string;
    password?: string;
    full_name?: string;
  };

  if (!email || !password || !full_name) {
    res.status(400).json({ error: "email, password, and full_name are required" });
    return;
  }

  if (!isPlausibleEmail(email)) {
    res.status(400).json({ error: "Please provide a valid, real email address" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await query<{ id: string; email_verified: boolean }>(
    "SELECT id, email_verified FROM users WHERE email = $1",
    [normalizedEmail]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    if (existing.rows[0].email_verified) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    // Unverified account from a previous incomplete signup — let them retry.
    await query("DELETE FROM users WHERE id = $1", [existing.rows[0].id]);
  }

  const password_hash = await bcrypt.hash(password, 12);
  const code = generateVerificationCode();

  const result = await query<{ id: string; email: string }>(
    `INSERT INTO users
       (email, password_hash, full_name, plan, email_verified,
        verification_code, verification_code_expires_at, verification_code_sent_at)
     VALUES ($1, $2, $3, 'free', FALSE, $4, NOW() + INTERVAL '${VERIFICATION_CODE_TTL_MINUTES} minutes', NOW())
     RETURNING id, email`,
    [normalizedEmail, password_hash, full_name, code]
  );

  const user = result.rows[0];

  try {
    await sendVerificationEmail(user.email, code);
  } catch (err) {
    console.error("Failed to send verification email:", err);
    await query("DELETE FROM users WHERE id = $1", [user.id]);
    res.status(502).json({
      error: "Could not send verification email. Please try again shortly.",
    });
    return;
  }

  res.status(201).json({
    user_id: user.id,
    email: user.email,
    message: "Verification code sent to your email. Verify to activate your account.",
  });
}

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { email, code } = req.body as { email?: string; code?: string };

  if (!email || !code) {
    res.status(400).json({ error: "email and code are required" });
    return;
  }

  const result = await query<{
    id: string;
    email: string;
    full_name: string;
    plan: string;
    verification_code: string | null;
    verification_code_expires_at: Date | null;
    email_verified: boolean;
  }>(
    `SELECT id, email, full_name, plan, verification_code, verification_code_expires_at, email_verified
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  const user = result.rows[0];
  if (!user) {
    res.status(400).json({ error: "Invalid email or code" });
    return;
  }

  if (user.email_verified) {
    res.status(409).json({ error: "Email already verified — log in instead" });
    return;
  }

  const expired =
    !user.verification_code_expires_at || user.verification_code_expires_at < new Date();

  if (!user.verification_code || user.verification_code !== code.trim() || expired) {
    res.status(400).json({ error: "Invalid or expired code" });
    return;
  }

  await query(
    `UPDATE users
     SET email_verified = TRUE, verification_code = NULL, verification_code_expires_at = NULL
     WHERE id = $1`,
    [user.id]
  );

  await recordLoginEvent({
    userId: user.id,
    email: user.email,
    success: true,
    reason: "email_verified",
    req,
  });

  const token = signToken({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    plan: user.plan,
  });

  res.json({
    user_id: user.id,
    email: user.email,
    token,
    plan: user.plan,
    message: "Email verified",
  });
}

export async function resendVerificationCode(
  req: Request,
  res: Response
): Promise<void> {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const result = await query<{
    id: string;
    email: string;
    email_verified: boolean;
    verification_code_sent_at: Date | null;
  }>(
    "SELECT id, email, email_verified, verification_code_sent_at FROM users WHERE email = $1",
    [email.toLowerCase().trim()]
  );

  const user = result.rows[0];
  // Don't reveal whether the account exists — respond the same either way.
  if (!user || user.email_verified) {
    res.json({ message: "If that account needs verification, a new code has been sent." });
    return;
  }

  if (
    user.verification_code_sent_at &&
    Date.now() - user.verification_code_sent_at.getTime() <
      VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000
  ) {
    res.status(429).json({
      error: `Please wait ${VERIFICATION_RESEND_COOLDOWN_SECONDS} seconds before requesting another code`,
    });
    return;
  }

  const code = generateVerificationCode();
  await query(
    `UPDATE users
     SET verification_code = $1,
         verification_code_expires_at = NOW() + INTERVAL '${VERIFICATION_CODE_TTL_MINUTES} minutes',
         verification_code_sent_at = NOW()
     WHERE id = $2`,
    [code, user.id]
  );

  try {
    await sendVerificationEmail(user.email, code);
  } catch (err) {
    console.error("Failed to resend verification email:", err);
    res.status(502).json({ error: "Could not send verification email. Please try again shortly." });
    return;
  }

  res.json({ message: "If that account needs verification, a new code has been sent." });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Try admin login first
  const adminResult = await query<{
    id: string;
    email: string;
    password_hash: string;
  }>("SELECT id, email, password_hash FROM admins WHERE email = $1", [
    normalizedEmail,
  ]);

  if (adminResult.rows[0]) {
    const admin = adminResult.rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      await recordLoginEvent({
        userId: null,
        email: normalizedEmail,
        success: false,
        reason: "bad_password",
        req,
      });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    await recordLoginEvent({
      userId: admin.id,
      email: admin.email,
      success: true,
      req,
    });
    const token = signToken({
      id: admin.id,
      email: admin.email,
      full_name: "Admin",
      plan: "enterprise",
      isAdmin: true,
    });
    res.json({ user_id: admin.id, email: admin.email, token, role: "admin" });
    return;
  }

  const result = await query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    plan: string;
    active: boolean;
    email_verified: boolean;
    stripe_subscription_status: string | null;
  }>(
    `SELECT id, email, password_hash, full_name, plan, active, email_verified,
            stripe_subscription_status
     FROM users WHERE email = $1`,
    [normalizedEmail]
  );

  const user = result.rows[0];
  if (!user || !user.active) {
    await recordLoginEvent({
      userId: user?.id ?? null,
      email: normalizedEmail,
      success: false,
      reason: user ? "inactive" : "no_such_user",
      req,
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await recordLoginEvent({
      userId: user.id,
      email: user.email,
      success: false,
      reason: "bad_password",
      req,
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (!user.email_verified) {
    await recordLoginEvent({
      userId: user.id,
      email: user.email,
      success: false,
      reason: "unverified",
      req,
    });
    res.status(403).json({
      error: "Please verify your email before logging in",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }

  await recordLoginEvent({
    userId: user.id,
    email: user.email,
    success: true,
    req,
  });

  const plan = effectivePlan(user.plan, user.stripe_subscription_status);
  const token = signToken({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    plan,
  });

  res.json({
    user_id: user.id,
    email: user.email,
    token,
    plan,
  });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.user.isAdmin) {
    res.json({
      id: req.user.id,
      email: req.user.email,
      full_name: req.user.full_name,
      plan: req.user.plan,
      role: "admin",
      created_at: null,
    });
    return;
  }

  const result = await query<{
    id: string;
    email: string;
    full_name: string;
    plan: string;
    created_at: Date;
    stripe_subscription_status: string | null;
  }>(
    `SELECT id, email, full_name, plan, created_at, stripe_subscription_status
     FROM users WHERE id = $1`,
    [req.user.id]
  );

  const user = result.rows[0];
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    plan: effectivePlan(user.plan, user.stripe_subscription_status),
    role: "user",
    created_at: user.created_at,
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.jti) {
    await query(
      `INSERT INTO revoked_tokens (jti, expires_at)
       VALUES ($1, NOW() + INTERVAL '24 hours')
       ON CONFLICT DO NOTHING`,
      [req.jti]
    );
  }
  res.json({ message: "Logged out" });
}
