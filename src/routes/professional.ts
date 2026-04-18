import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, asc, desc, gte, inArray } from "drizzle-orm";
import { env } from "../env.js";
import { getVapidPublicKey } from "../services/push.service.js";
import {
  hashPassword,
  verifyPassword,
} from "../services/auth.service.js";
import type { Database } from "../db/index.js";
import type { User, Professional } from "../db/schema.js";

// Define a type for the context variables
type AppContext = {
  Variables: {
    user: User;
    professional: Professional;
  };
};

export function createProfessionalRoutes(database: Database) {
  const app = new Hono<AppContext>();
  const { db, schema } = database;

  // Auth middleware to get user and professional
  const authMiddleware = async (c: any, next: () => Promise<void>) => {
    const payload = c.get("jwtPayload");
    const userId = payload.sub as number;

    const [user] = await (db as any)
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    const [professional] = await (db as any)
      .select()
      .from(schema.professionals)
      .where(eq(schema.professionals.id, user.professionalId));
    if (!professional) {
      return c.json({ error: "Professional account not found" }, 401);
    }

    c.set("user", user);
    c.set("professional", professional);
    await next();
  };

  // All routes require authentication
  app.use("/*", jwt({ secret: env.JWT_SECRET, alg: "HS256" }), authMiddleware);

  // Get my profile
  app.get("/me", async (c) => {
    const user = c.get("user");
    const professional = c.get("professional");

    return c.json({
      id: professional.id,
      email: user.email,
      name: professional.companyName,
      plan: professional.plan,
    });
  });

  // Update my profile
  app.put(
    "/me",
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      const professional = c.get("professional");
      const { name, email } = c.req.valid("json");

      if (email && email !== user.email) {
        const [existing] = await (db as any)
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);
        if (existing) {
          return c.json({ error: "Email already in use" }, 409);
        }
        await (db as any)
          .update(schema.users)
          .set({ email, updatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
      }

      if (name) {
        await (db as any)
          .update(schema.professionals)
          .set({ companyName: name, updatedAt: new Date() })
          .where(eq(schema.professionals.id, professional.id));
      }

      // Return updated profile
      const [updatedUser] = await (db as any)
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      const [updatedPro] = await (db as any)
        .select()
        .from(schema.professionals)
        .where(eq(schema.professionals.id, professional.id));

      return c.json({
        id: updatedPro.id,
        email: updatedUser.email,
        name: updatedPro.companyName,
        plan: updatedPro.plan,
      });
    },
  );

  // Change password
  app.put(
    "/password",
    zValidator(
      "json",
      z.object({
        currentPassword: z.string(),
        newPassword: z.string().min(6),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      const { currentPassword, newPassword } = c.req.valid("json");

      const valid = await verifyPassword(currentPassword, user.password);
      if (!valid) {
        return c.json({ error: "Invalid current password" }, 400);
      }

      const hashed = await hashPassword(newPassword);
      await (db as any)
        .update(schema.users)
        .set({ password: hashed, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));

      return c.json({ success: true });
    },
  );

  // Delete my account
  app.delete("/me", async (c) => {
    const professional = c.get("professional");

    // Cascade delete: professionals → users, queues → tickets (all via DB cascade)
    await (db as any)
      .delete(schema.professionals)
      .where(eq(schema.professionals.id, professional.id));

    return c.json({ success: true });
  });

  // Get all my queues
  app.get("/queues", async (c) => {
    const professional = c.get("professional");

    const queues = await (db as any)
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.professionalId, professional.id))
      .orderBy(desc(schema.queues.createdAt));

    return c.json(queues);
  });

  // Get specific queue with details
  app.get("/queue/:id", async (c) => {
    const professional = c.get("professional");
    const queueId = parseInt(c.req.param("id"), 10);

    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professional.id),
        ),
      );

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // Get waiting tickets
    const waitingTickets = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queue.id),
          eq(schema.tickets.status, "waiting"),
        ),
      )
      .orderBy(schema.tickets.number);

    // Get all current tickets (multi-current support), oldest called first
    const currentTickets = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queue.id),
          eq(schema.tickets.status, "current"),
        ),
      )
      .orderBy(asc(schema.tickets.calledAt));

    return c.json({
      queue: {
        id: queue.id,
        name: queue.name,
        slug: queue.slug,
        currentNumber: queue.currentNumber,
        nextTicket: queue.nextTicket,
        isActive: queue.isActive,
      },
      currentTickets,
      waitingTickets,
    });
  });

  // Get QR code data for a specific queue
  app.get("/queue/:id/qrcode", async (c) => {
    const professional = c.get("professional");
    const queueId = parseInt(c.req.param("id"), 10);

    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professional.id),
        ),
      );

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // URL publique pour les clients
    const publicUrl = `https://byewait.fr/q/${queue.slug}`;

    return c.json({
      queueId: queue.id,
      slug: queue.slug,
      name: queue.name,
      url: publicUrl,
    });
  });

  // Get hourly stats for today (all queues)
  app.get("/stats/hourly", async (c) => {
    const professional = c.get("professional");
    const today = new Date().toISOString().split("T")[0];

    // Get all queue IDs for this professional
    const queues = await (db as any)
      .select({ id: schema.queues.id })
      .from(schema.queues)
      .where(eq(schema.queues.professionalId, professional.id));

    const queueIds = queues.map((q: any) => q.id);

    if (queueIds.length === 0) {
      return c.json([]);
    }

    // Get all tickets today for these queues
    const tickets = await (db as any)
      .select({ createdAt: schema.tickets.createdAt })
      .from(schema.tickets)
      .where(
        and(
          inArray(schema.tickets.queueId, queueIds),
          gte(schema.tickets.createdAt, new Date(today)),
        ),
      );

    // Group by hour
    const hourly: Record<number, number> = {};
    for (const t of tickets) {
      const hour = new Date(t.createdAt).getHours();
      hourly[hour] = (hourly[hour] || 0) + 1;
    }

    // Return 8h-22h range
    const result = [];
    for (let h = 8; h <= 22; h++) {
      result.push({ hour: `${h}h`, tickets: hourly[h] || 0 });
    }

    return c.json(result);
  });

  // Get VAPID public key for push notifications
  app.get("/vapid-key", (c) => {
    const key = getVapidPublicKey();
    if (!key) {
      return c.json({ error: "Push notifications not configured" }, 503);
    }
    return c.json({ publicKey: key });
  });

  return app;
}
