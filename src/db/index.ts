import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";

// MySQL connection and drizzle instance
export async function createMysqlDb(connectionString: string) {
  const pool = mysql.createPool(connectionString);
  const db = drizzle(pool, { mode: "default" });
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

// Alias pour compatibilité
export const createDb = createMysqlDb;

// Type for the database instance
export type Database = Awaited<ReturnType<typeof createMysqlDb>>;

export * from "./schema.js";
