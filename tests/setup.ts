import { beforeAll, afterAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database, type DbDriver } from '../src/db/index.js'

// Use MySQL by default for local testing
const driver = (process.env.DB_DRIVER || 'mysql') as DbDriver
const connectionString = process.env.DATABASE_URL ||
  (driver === 'mysql'
    ? 'mysql://root:buse.974@localhost:3306/qless_test'
    : 'postgresql://qless:qless@localhost:5432/qless_test')

let database: Database

export async function getTestDatabase(): Promise<Database> {
  if (!database) {
    database = await createDb(driver, connectionString)
  }
  return database
}

export async function cleanDatabase(db: Database): Promise<void> {
  const { schema } = db

  // Delete in order due to foreign keys
  await (db.db as any).delete(schema.tickets)
  await (db.db as any).delete(schema.queues)
  await (db.db as any).delete(schema.professionals)
}

export async function setupTestDatabase(): Promise<void> {
  const db = await getTestDatabase()

  // Create tables if they don't exist
  if (driver === 'mysql') {
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS professionals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `)
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS queues (
        id INT AUTO_INCREMENT PRIMARY KEY,
        professional_id INT NOT NULL,
        current_number INT NOT NULL DEFAULT 0,
        next_ticket INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (professional_id) REFERENCES professionals(id) ON DELETE CASCADE
      )
    `)
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        queue_id INT NOT NULL,
        number INT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'waiting',
        push_subscription TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE
      )
    `)
  } else {
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS professionals (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `)
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS queues (
        id SERIAL PRIMARY KEY,
        professional_id INT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
        current_number INT NOT NULL DEFAULT 0,
        next_ticket INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `)
    await (db.db as any).execute(sql`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        queue_id INT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        number INT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'waiting',
        push_subscription TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `)
  }
}

export async function teardownTestDatabase(): Promise<void> {
  if (database) {
    await database.close()
  }
}

// Global setup
beforeAll(async () => {
  await setupTestDatabase()
})

beforeEach(async () => {
  const db = await getTestDatabase()
  await cleanDatabase(db)
})

afterAll(async () => {
  await teardownTestDatabase()
})
