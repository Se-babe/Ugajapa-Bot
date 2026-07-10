import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query } from "./db";

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
    }>("SELECT id, email, full_name, plan, active FROM users WHERE id = $1", [
      decoded.sub,
    ]);

    if (!userResult.rows[0] || !userResult.rows[0].active) {
      res.status(401).json({ error: "User not found or inactive" });
      return;
    }

    const u = userResult.rows[0];
    req.user = {
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      plan: u.plan,
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

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const existing = await query("SELECT id FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  if (existing.rowCount && existing.rowCount > 0) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const password_hash = await bcrypt.hash(password, 12);
  const result = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, full_name, plan)
     VALUES ($1, $2, $3, 'free')
     RETURNING id, email`,
    [email.toLowerCase(), password_hash, full_name]
  );

  const user = result.rows[0];
  const token = signToken({
    id: user.id,
    email: user.email,
    full_name,
    plan: "free",
  });

  res.status(201).json({
    user_id: user.id,
    email: user.email,
    token,
    message: "Account created",
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  // Try admin login first
  const adminResult = await query<{
    id: string;
    email: string;
    password_hash: string;
  }>("SELECT id, email, password_hash FROM admins WHERE email = $1", [
    email.toLowerCase(),
  ]);

  if (adminResult.rows[0]) {
    const admin = adminResult.rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
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
  }>(
    "SELECT id, email, password_hash, full_name, plan, active FROM users WHERE email = $1",
    [email.toLowerCase()]
  );

  const user = result.rows[0];
  if (!user || !user.active) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

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
  });
}

export async function getMe(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.json({
    user_id: req.user.id,
    email: req.user.email,
    full_name: req.user.full_name,
    plan: req.user.plan,
    is_admin: req.user.isAdmin || false,
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
