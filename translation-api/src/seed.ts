import bcrypt from "bcryptjs";
import { pool, query } from "./db";

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
