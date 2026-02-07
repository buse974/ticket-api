import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { eq, and, desc } from "drizzle-orm";
import { env } from "../env.js";
import { getVapidPublicKey } from "../services/push.service.js";
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

    // Get current ticket
    const [currentTicket] = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queue.id),
          eq(schema.tickets.status, "current"),
        ),
      )
      .limit(1);

    return c.json({
      queue: {
        id: queue.id,
        name: queue.name,
        slug: queue.slug,
        currentNumber: queue.currentNumber,
        nextTicket: queue.nextTicket,
        isActive: queue.isActive,
      },
      currentTicket: currentTicket || null,
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
