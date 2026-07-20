import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { pool, query } from "./db";

/** Apply schema.sql on first deploy (e.g. Render) when tables are missing. */
export async function ensureSchema(): Promise<void> {
  const check = await query<{ users: string | null }>(
    "SELECT to_regclass('public.users') AS users"
  );
  if (!check.rows[0]?.users) {
    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    await pool.query(sql);
    console.log("Database schema applied.");
  }

  await applyMigrations();
}

/**
 * Idempotent, additive migrations — safe to run on every boot, including
 * against an already-live database (e.g. the deployed Render instance).
 * Existing accounts are grandfathered as verified so this change can't
 * lock out anyone who signed up before email verification existed.
 */
async function applyMigrations(): Promise<void> {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(10);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_sent_at TIMESTAMPTZ;

    -- No FK on user_id: it may reference either users or admins (two
    -- separate tables), and a failed login has no valid id to point to.
    CREATE TABLE IF NOT EXISTS login_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      email VARCHAR(255) NOT NULL,
      success BOOLEAN NOT NULL,
      reason VARCHAR(64),
      ip_address VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE login_events DROP CONSTRAINT IF EXISTS login_events_user_id_fkey;
    CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS admins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_status VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_current_period_end TIMESTAMPTZ;
    ALTER TABLE billing ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255);
    ALTER TABLE billing ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);
    ALTER TABLE billing ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    -- Revoke unpaid self-serve upgrades (plan was set without Stripe payment).
    UPDATE users
    SET plan = 'free',
        stripe_subscription_id = NULL,
        stripe_subscription_status = NULL
    WHERE plan IN ('starter', 'business')
      AND (
        stripe_subscription_status IS NULL
        OR stripe_subscription_status NOT IN ('active', 'trialing', 'admin_granted')
      );
  `);
}

/**
 * Ensure a seed admin account exists (from ADMIN_EMAIL / ADMIN_PASSWORD).
 */
export async function seedAdmin(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || "admin@ugajapa.ac.ug").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMeAdmin123!";

  const existing = await query("SELECT id FROM admins WHERE email = $1", [email]);
  if (existing.rowCount && existing.rowCount > 0) return;

  const password_hash = await bcrypt.hash(password, 12);
  await query(
    "INSERT INTO admins (email, password_hash) VALUES ($1, $2)",
    [email, password_hash]
  );
  console.log(`Seed admin created: ${email}`);
}

export async function waitForDb(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Database not reachable");
}
