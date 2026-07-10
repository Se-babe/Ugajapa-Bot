import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { pool, query } from "./db";

/** Apply schema.sql on first deploy (e.g. Render) when tables are missing. */
export async function ensureSchema(): Promise<void> {
  const check = await query<{ users: string | null }>(
    "SELECT to_regclass('public.users') AS users"
  );
  if (check.rows[0]?.users) return;

  const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  console.log("Database schema applied.");
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
