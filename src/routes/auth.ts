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
    const [professional] = await (db as any)
      .insert(schema.professionals)
      .values({
        companyName: name,
        plan: "free",
      })
      .returning({ id: schema.professionals.id });

    const professionalId = professional.id;

    // Create user
    const hashedPassword = await hashPassword(password);
    const [user] = await (db as any)
      .insert(schema.users)
      .values({
        professionalId,
        email,
        password: hashedPassword,
        name,
        role: "owner",
      })
      .returning({ id: schema.users.id });

    const userId = user.id;

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
    const [professionalData] = await (db as any)
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
          id: professionalData.id,
          email: email,
          name: professionalData.companyName,
          plan: professionalData.plan,
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
      return c.json(
        { error: "Could not find associated professional account." },
        500,
      );
    }

    // 4. Create token
    const token = await createToken({
      sub: user.id,
      email: user.email,
    });

    // 5. Return response
    return c.json({
      token,
      professional: {
        id: professional.id,
        email: user.email,
        name: professional.companyName,
        plan: professional.plan,
      },
    });
  });

  return app;
}
