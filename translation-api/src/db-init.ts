import fs from "fs";
import path from "path";
import { pool } from "./db";

async function main() {
  const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  console.log("Database schema applied successfully.");
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to init database:", err);
  process.exit(1);
});
