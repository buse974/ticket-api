import "dotenv/config";
import { createMysqlDb } from "./index.js";
import { hashPassword } from "../services/auth.service.js";
import { eq } from "drizzle-orm";

async function seed() {
  console.log("🌱 Seeding database...");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const database = await createMysqlDb(databaseUrl);
  const { db, schema } = database;

  // Check if demo user already exists
  const [existingUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, "demo@byewait.fr"))
    .limit(1);

  if (existingUser) {
    console.log("✅ Demo user already exists");
    console.log("\n📧 Email: demo@byewait.fr");
    console.log("🔑 Password: demo123");
    await database.close();
    process.exit(0);
  }

  // 1. Create demo professional (the company)
  const professionalResult = await db.insert(schema.professionals).values({
    companyName: "Salon Martin",
    plan: "pro", // demo with pro plan
  });
  const professionalId = professionalResult[0].insertId;
  console.log("🏢 Professional account 'Salon Martin' created.");

  // 2. Create a user for that professional
  const hashedPassword = await hashPassword("demo123");
  await db.insert(schema.users).values({
    professionalId,
    email: "demo@byewait.fr",
    password: hashedPassword,
    name: "Jean Martin", // Owner's name
    role: "owner",
  });
  console.log("👤 Owner user 'Jean Martin' created.");

  // 3. Create multiple queues for the professional
  const queuesData = [
    { name: "Coupe Homme" },
    { name: "Coupe Femme" },
    { name: "Coloration" },
  ];

  for (const queue of queuesData) {
    const slug = `${"Salon Martin".toLowerCase().replace(/ /g, "-")}-${queue.name.toLowerCase().replace(/ /g, "-")}-${Date.now()}`;
    await db.insert(schema.queues).values({
      professionalId,
      name: queue.name,
      slug: slug,
    });
  }
  console.log("📋 3 queues created.");

  console.log("\n✅ Demo user and professional created with 3 queues!");
  console.log("\n📧 Login with Email: demo@byewait.fr");
  console.log("🔑 Password: demo123");
  console.log("\n📋 Files créées:");
  queuesData.forEach((q) => console.log(`   - ${q.name}`));

  await database.close();
  process.exit(0);
}

seed().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
