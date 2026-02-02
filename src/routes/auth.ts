import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  hashPassword,
  verifyPassword,
  createToken,
} from "../services/auth.service.js";
import type { Database } from "../db/index.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Helper: génère un slug unique
function generateSlug(name: string, uniqueSuffix: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}-${uniqueSuffix}`;
}

export function createAuthRoutes(database: Database) {
  const app = new Hono();
  const { db, schema } = database;

  // Register
  app.post("/register", zValidator("json", registerSchema), async (c) => {
    const { email, password, name } = c.req.valid("json");

    // Check if email already exists in users table
    const existingUser = await (db as any)
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existingUser.length > 0) {
      return c.json({ error: "Email already registered" }, 409);
    }

    // Create professional
    const professionalResult = await (db as any)
      .insert(schema.professionals)
      .values({
        companyName: name, // Use name for company name
        plan: "free",
      });

    const professionalId =
      "insertId" in professionalResult[0]
        ? professionalResult[0].insertId
        : (professionalResult[0]?.id ?? professionalResult.lastInsertRowid);

    // Create user
    const hashedPassword = await hashPassword(password);
    const userResult = await (db as any).insert(schema.users).values({
      professionalId,
      email,
      password: hashedPassword,
      name,
      role: "owner",
    });

    const userId =
      "insertId" in userResult[0]
        ? userResult[0].insertId
        : (userResult[0]?.id ?? userResult.lastInsertRowid);

    // Create default queue for the professional
    const defaultQueueName = "File principale";
    const slug = generateSlug(
      defaultQueueName,
      `${professionalId}-${Date.now()}`,
    );

    await (db as any).insert(schema.queues).values({
      professionalId,
      name: defaultQueueName,
      slug,
      currentNumber: 0,
      nextTicket: 1,
      isActive: true,
      allowRemoteBooking: true,
    });

    // Get created professional for response
    const [professional] = await (db as any)
      .select({
        id: schema.professionals.id,
        companyName: schema.professionals.companyName,
        plan: schema.professionals.plan,
      })
      .from(schema.professionals)
      .where(eq(schema.professionals.id, professionalId));

    const token = await createToken({
      sub: userId,
      email: email,
    });

    return c.json(
      {
        token,
        professional: {
          id: professional.id,
          email: email,
          name: professional.companyName,
          plan: professional.plan,
        },
      },
      201,
    );
  });

  // Login
  app.post("/login", zValidator("json", loginSchema), async (c) => {
    const { email, password } = c.req.valid("json");

    // 1. Find user by email
    const [user] = await (db as any)
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!user) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    // 2. Verify password
    const validPassword = await verifyPassword(password, user.password);
    if (!validPassword) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    // 3. Find professional
    const [professional] = await (db as any)
      .select({
        id: schema.professionals.id,
        companyName: schema.professionals.companyName,
        plan: schema.professionals.plan,
      })
      .from(schema.professionals)
      .where(eq(schema.professionals.id, user.professionalId));

    if (!professional) {
      // This would indicate data inconsistency
      return c.json(
        { error: "Could not find associated professional account." },
        500,
      );
    }

    // 4. Create token
    const token = await createToken({
      sub: user.id, // Use user ID for token subject
      email: user.email,
    });

    // 5. Return response
    return c.json({
      token,
      professional: {
        id: professional.id,
        email: user.email, // email is on user table
        name: professional.companyName, // name is companyName on professionals table
        plan: professional.plan,
      },
    });
  });

  return app;
}
