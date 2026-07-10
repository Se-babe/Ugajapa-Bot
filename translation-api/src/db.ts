import { Pool, QueryResult, QueryResultRow } from "pg";

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required in production. On Render: create a Postgres database, " +
      "then add its Internal Database URL to this service's Environment."
  );
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://mmuser:mmuser_password@localhost:5432/ugajapa_api";

const needsSsl =
  process.env.DATABASE_SSL === "true" ||
  process.env.NODE_ENV === "production" ||
  /render\.com|sslmode=require/i.test(DATABASE_URL);

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

// Prevent an idle client disconnect from crashing the whole API process.
pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withClient<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
