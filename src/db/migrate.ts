import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const { Pool } = pg;

async function needsBaseline(pool: pg.Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    // Check if drizzle journal exists and has entries
    const journalResult = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      )`,
    );
    const hasJournal = journalResult.rows[0].exists;

    if (!hasJournal) {
      // No journal at all — check if app tables exist (existing DB without drizzle)
      const tablesResult = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'professionals')`,
      );
      return tablesResult.rows[0].exists;
    }

    // Journal exists — check if it has any entries
    const entriesResult = await client.query(
      `SELECT count(*) as cnt FROM drizzle.__drizzle_migrations`,
    );
    const hasEntries = parseInt(entriesResult.rows[0].cnt) > 0;

    if (!hasEntries) {
      // Empty journal — check if app tables exist
      const tablesResult = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'professionals')`,
      );
      return tablesResult.rows[0].exists;
    }

    return false;
  } finally {
    client.release();
  }
}

async function applyBaseline(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    await client.query(
      `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      ["0000_previous_owl", Date.now()],
    );
    console.log("Baseline applied: initial migration marked as done");
  } finally {
    client.release();
  }
}

export async function runMigrations(connectionString: string) {
  const pool = new Pool({ connectionString });

  try {
    if (await needsBaseline(pool)) {
      await applyBaseline(pool);
    }

    const db = drizzle(pool);
    console.log("Running migrations...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations completed");
  } finally {
    await pool.end();
  }
}

// Allow running standalone: npm run db:migrate
if (process.argv[1]?.includes("migrate")) {
  const url =
    process.env.DATABASE_URL ||
    "postgresql://admin:buse.974@localhost:5432/qless";
  runMigrations(url)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
