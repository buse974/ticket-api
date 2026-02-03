import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

// PostgreSQL connection and drizzle instance
export async function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    schema: {
      ...schema,
    },
    close: async () => {
      await pool.end();
    },
  };
}

// Type for the database instance
export type Database = Awaited<ReturnType<typeof createDb>>;

export * from "./schema.js";
