import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, count, sql, gte, desc } from "drizzle-orm";
import { jwt } from "hono/jwt";
import { env } from "../env.js";
import { sendPushNotification } from "../services/push.service.js";
import type { Database } from "../db/index.js";
import type { QueueInfo, TicketInfo, WSMessage } from "../types.js";
import { PLAN_LIMITS, ANTI_ABUSE_LIMITS } from "../db/schema.js";

const jwtMiddleware = jwt({ secret: env.JWT_SECRET, alg: "HS256" });

const takeTicketSchema = z.object({
  pushSubscription: z.string().optional(),
});

const createQueueSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateQueueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  allowRemoteBooking: z.boolean().optional(),
});

export type BroadcastFn = (queueId: number, message: WSMessage) => void;

// Helper: generate slug from name
function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") +
    "-" +
    Math.random().toString(36).substring(2, 8)
  );
}

// Helper: get today's date as YYYY-MM-DD
function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

// Helper: calculate queue stats
async function getQueueStats(db: any, schema: any, queueId: number) {
  const today = getToday();

  // Get today's tickets
  const todayTickets = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.queueId, queueId),
        gte(schema.tickets.createdAt, new Date(today)),
      ),
    );

  const waiting = todayTickets.filter(
    (t: any) => t.status === "waiting",
  ).length;
  const completed = todayTickets.filter(
    (t: any) => t.status === "completed",
  ).length;
  const noShow = todayTickets.filter((t: any) => t.status === "no_show").length;
  const remote = todayTickets.filter((t: any) => t.isRemote).length;
  const totalToday = todayTickets.length;

  // Calculate average times
  const completedTickets = todayTickets.filter(
    (t: any) => t.status === "completed" && t.calledAt && t.completedAt,
  );

  let avgWaitTime = 0;
  let avgServiceTime = 0;

  if (completedTickets.length > 0) {
    const waitTimes = completedTickets
      .filter((t: any) => t.calledAt)
      .map(
        (t: any) =>
          (new Date(t.calledAt).getTime() - new Date(t.createdAt).getTime()) /
          1000,
      );

    const serviceTimes = completedTickets
      .filter((t: any) => t.completedAt && t.calledAt)
      .map(
        (t: any) =>
          (new Date(t.completedAt).getTime() - new Date(t.calledAt).getTime()) /
          1000,
      );

    if (waitTimes.length > 0) {
      avgWaitTime = Math.round(
        waitTimes.reduce((a: number, b: number) => a + b, 0) / waitTimes.length,
      );
    }
    if (serviceTimes.length > 0) {
      avgServiceTime = Math.round(
        serviceTimes.reduce((a: number, b: number) => a + b, 0) /
          serviceTimes.length,
      );
    }
  }

  // Estimate end time
  let estimatedEndTime: string | null = null;
  if (waiting > 0 && avgServiceTime > 0) {
    const remainingSeconds = waiting * avgServiceTime;
    const endTime = new Date(Date.now() + remainingSeconds * 1000);
    estimatedEndTime = endTime.toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return {
    totalToday,
    completed,
    noShow,
    waiting,
    remote,
    noShowRate: totalToday > 0 ? Math.round((noShow / totalToday) * 100) : 0,
    avgWaitTime,
    avgServiceTime,
    estimatedEndTime,
  };
}

export function createQueueRoutes(database: Database, broadcast: BroadcastFn) {
  const app = new Hono();
  const { db, schema } = database;

  // ============================================
  // AUTHENTICATED ROUTES (Professional)
  // ============================================

  // Get all queues for authenticated professional
  app.get("/", jwtMiddleware, async (c) => {
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    const queues = await (db as any)
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.professionalId, professionalId))
      .orderBy(desc(schema.queues.createdAt));

    // Get stats for each queue
    const queuesWithStats = await Promise.all(
      queues.map(async (queue: any) => {
        const stats = await getQueueStats(db, schema, queue.id);
        return {
          id: queue.id,
          name: queue.name,
          slug: queue.slug,
          currentNumber: queue.currentNumber,
          nextTicket: queue.nextTicket,
          isActive: queue.isActive,
          allowRemoteBooking: queue.allowRemoteBooking,
          stats,
        };
      }),
    );

    return c.json(queuesWithStats);
  });

  // Create a new queue
  app.post(
    "/",
    jwtMiddleware,
    zValidator("json", createQueueSchema),
    async (c) => {
      const payload = c.get("jwtPayload");
      const professionalId = parseInt(payload.sub as string, 10);
      const { name } = c.req.valid("json");

      // Get professional's plan
      const [professional] = await (db as any)
        .select()
        .from(schema.professionals)
        .where(eq(schema.professionals.id, professionalId))
        .limit(1);

      if (!professional) {
        return c.json({ error: "Professional not found" }, 404);
      }

      // Create queue
      const slug = generateSlug(name);
      const result = await (db as any).insert(schema.queues).values({
        professionalId,
        name,
        slug,
        currentNumber: 0,
        nextTicket: 1,
        isActive: true,
        allowRemoteBooking: true,
      });

      const queueId = result[0]?.insertId;

      return c.json(
        {
          id: queueId,
          name,
          slug,
          currentNumber: 0,
          nextTicket: 1,
          isActive: true,
          allowRemoteBooking: true,
        },
        201,
      );
    },
  );

  // Update a queue
  app.patch(
    "/:id",
    jwtMiddleware,
    zValidator("json", updateQueueSchema),
    async (c) => {
      const queueId = parseInt(c.req.param("id"), 10);
      const payload = c.get("jwtPayload");
      const professionalId = parseInt(payload.sub as string, 10);
      const updates = c.req.valid("json");

      // Verify ownership
      const [queue] = await (db as any)
        .select()
        .from(schema.queues)
        .where(
          and(
            eq(schema.queues.id, queueId),
            eq(schema.queues.professionalId, professionalId),
          ),
        )
        .limit(1);

      if (!queue) {
        return c.json({ error: "Queue not found" }, 404);
      }

      await (db as any)
        .update(schema.queues)
        .set(updates)
        .where(eq(schema.queues.id, queueId));

      return c.json({ success: true });
    },
  );

  // Delete a queue
  app.delete("/:id", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    await (db as any)
      .delete(schema.queues)
      .where(eq(schema.queues.id, queueId));

    return c.json({ success: true });
  });

  // Get queue stats
  app.get("/:id/stats", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    const stats = await getQueueStats(db, schema, queueId);
    return c.json(stats);
  });

  // Complete current ticket
  app.post("/:id/complete", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // Mark current ticket as completed
    await (db as any)
      .update(schema.tickets)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "current"),
        ),
      );

    // Get next waiting ticket
    const waitingTickets = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      )
      .orderBy(schema.tickets.number)
      .limit(1);

    let currentTicket = null;
    if (waitingTickets.length > 0) {
      const next = waitingTickets[0];
      await (db as any)
        .update(schema.tickets)
        .set({ status: "current", calledAt: new Date() })
        .where(eq(schema.tickets.id, next.id));

      await (db as any)
        .update(schema.queues)
        .set({ currentNumber: next.number })
        .where(eq(schema.queues.id, queueId));

      currentTicket = { ...next, status: "current" };

      // Send push notification
      if (next.pushSubscription) {
        await sendPushNotification(next.pushSubscription, {
          title: "C'est votre tour !",
          body: `Ticket n°${next.number} - Présentez-vous maintenant`,
          ticketNumber: next.number,
        });
      }

      broadcast(queueId, {
        type: "ticket:called",
        payload: { number: next.number },
      });
    }

    const stats = await getQueueStats(db, schema, queueId);
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return c.json({ currentTicket, stats });
  });

  // Mark current ticket as no-show
  app.post("/:id/no-show", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // Mark current ticket as no_show
    await (db as any)
      .update(schema.tickets)
      .set({ status: "no_show", completedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "current"),
        ),
      );

    // Get next waiting ticket
    const waitingTickets = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      )
      .orderBy(schema.tickets.number)
      .limit(1);

    let currentTicket = null;
    if (waitingTickets.length > 0) {
      const next = waitingTickets[0];
      await (db as any)
        .update(schema.tickets)
        .set({ status: "current", calledAt: new Date() })
        .where(eq(schema.tickets.id, next.id));

      await (db as any)
        .update(schema.queues)
        .set({ currentNumber: next.number })
        .where(eq(schema.queues.id, queueId));

      currentTicket = { ...next, status: "current" };

      // Send push notification
      if (next.pushSubscription) {
        await sendPushNotification(next.pushSubscription, {
          title: "C'est votre tour !",
          body: `Ticket n°${next.number} - Présentez-vous maintenant`,
          ticketNumber: next.number,
        });
      }

      broadcast(queueId, {
        type: "ticket:called",
        payload: { number: next.number },
      });
    }

    const stats = await getQueueStats(db, schema, queueId);
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return c.json({ currentTicket, stats });
  });

  // Call next ticket (without completing current)
  app.post("/:id/call-next", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // Get next waiting ticket
    const waitingTickets = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      )
      .orderBy(schema.tickets.number)
      .limit(1);

    if (waitingTickets.length === 0) {
      return c.json({ error: "No tickets waiting" }, 400);
    }

    const next = waitingTickets[0];

    // Update ticket to current
    await (db as any)
      .update(schema.tickets)
      .set({ status: "current", calledAt: new Date() })
      .where(eq(schema.tickets.id, next.id));

    // Update queue current number
    await (db as any)
      .update(schema.queues)
      .set({ currentNumber: next.number })
      .where(eq(schema.queues.id, queueId));

    // Send push notification
    if (next.pushSubscription) {
      await sendPushNotification(next.pushSubscription, {
        title: "C'est votre tour !",
        body: `Ticket n°${next.number} - Présentez-vous maintenant`,
        ticketNumber: next.number,
      });
    }

    const stats = await getQueueStats(db, schema, queueId);
    broadcast(queueId, {
      type: "ticket:called",
      payload: { number: next.number },
    });
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return c.json({ currentTicket: { ...next, status: "current" }, stats });
  });

  // Reset queue (delete all tickets, reset counters)
  app.post("/:id/reset", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const professionalId = parseInt(payload.sub as string, 10);

    // Verify ownership
    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(
        and(
          eq(schema.queues.id, queueId),
          eq(schema.queues.professionalId, professionalId),
        ),
      )
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    // Delete all tickets
    await (db as any)
      .delete(schema.tickets)
      .where(eq(schema.tickets.queueId, queueId));

    // Reset counters
    await (db as any)
      .update(schema.queues)
      .set({ currentNumber: 0, nextTicket: 1 })
      .where(eq(schema.queues.id, queueId));

    broadcast(queueId, {
      type: "queue:update",
      payload: { queueId, reset: true },
    });

    return c.json({ success: true });
  });

  // ============================================
  // PUBLIC ROUTES
  // ============================================

  // Get queue info by ID (public)
  app.get("/:id", async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);

    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.id, queueId))
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    const [waitingResult] = await (db as any)
      .select({ count: count() })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      );

    // Get professional name
    const [professional] = await (db as any)
      .select()
      .from(schema.professionals)
      .where(eq(schema.professionals.id, queue.professionalId))
      .limit(1);

    return c.json({
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      currentNumber: queue.currentNumber,
      nextTicket: queue.nextTicket,
      waitingCount: Number(waitingResult?.count ?? 0),
      isActive: queue.isActive,
      allowRemoteBooking: queue.allowRemoteBooking,
      professionalName: professional?.name || "Unknown",
    });
  });

  // Get queue by slug (public)
  app.get("/slug/:slug", async (c) => {
    const slug = c.req.param("slug");

    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.slug, slug))
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    const [waitingResult] = await (db as any)
      .select({ count: count() })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queue.id),
          eq(schema.tickets.status, "waiting"),
        ),
      );

    // Get professional name
    const [professional] = await (db as any)
      .select()
      .from(schema.professionals)
      .where(eq(schema.professionals.id, queue.professionalId))
      .limit(1);

    return c.json({
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      currentNumber: queue.currentNumber,
      nextTicket: queue.nextTicket,
      waitingCount: Number(waitingResult?.count ?? 0),
      isActive: queue.isActive,
      allowRemoteBooking: queue.allowRemoteBooking,
      professionalName: professional?.name || "Unknown",
    });
  });

  // Take a ticket (public)
  app.post("/:id/ticket", zValidator("json", takeTicketSchema), async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const { pushSubscription } = c.req.valid("json");
    const clientIp =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const isRemote = c.req.header("x-remote-booking") === "true";

    const [queue] = await (db as any)
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.id, queueId))
      .limit(1);

    if (!queue) {
      return c.json({ error: "Queue not found" }, 404);
    }

    if (!queue.isActive) {
      return c.json({ error: "Queue is closed" }, 400);
    }

    if (isRemote && !queue.allowRemoteBooking) {
      return c.json({ error: "Remote booking is disabled" }, 400);
    }

    // Anti-abuse check for remote bookings
    if (isRemote && clientIp !== "unknown") {
      const today = getToday();
      const [ipRecord] = await (db as any)
        .select()
        .from(schema.ipTracking)
        .where(
          and(
            eq(schema.ipTracking.queueId, queueId),
            eq(schema.ipTracking.clientIp, clientIp),
            eq(schema.ipTracking.date, today),
          ),
        )
        .limit(1);

      if (
        ipRecord &&
        ipRecord.ticketCount >= ANTI_ABUSE_LIMITS.maxTicketsPerIpPerDay
      ) {
        return c.json({ error: "Daily limit reached for this IP" }, 429);
      }

      // Update or create IP tracking
      if (ipRecord) {
        await (db as any)
          .update(schema.ipTracking)
          .set({ ticketCount: ipRecord.ticketCount + 1 })
          .where(eq(schema.ipTracking.id, ipRecord.id));
      } else {
        await (db as any).insert(schema.ipTracking).values({
          queueId,
          clientIp,
          ticketCount: 1,
          date: today,
        });
      }
    }

    const ticketNumber = queue.nextTicket;

    // Create ticket
    const result = await (db as any).insert(schema.tickets).values({
      queueId,
      number: ticketNumber,
      status: "waiting",
      clientIp: isRemote ? clientIp : null,
      isRemote,
      pushSubscription: pushSubscription || null,
    });

    const ticketId = result[0]?.insertId;

    // Increment next ticket number
    await (db as any)
      .update(schema.queues)
      .set({ nextTicket: ticketNumber + 1 })
      .where(eq(schema.queues.id, queueId));

    // Calculate position
    const [positionResult] = await (db as any)
      .select({ count: count() })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      );

    const position = Number(positionResult?.count ?? 1);

    // Estimate wait time
    const stats = await getQueueStats(db, schema, queueId);
    const estimatedWaitMinutes =
      stats.avgServiceTime > 0
        ? Math.round((position * stats.avgServiceTime) / 60)
        : null;

    broadcast(queueId, {
      type: "queue:update",
      payload: {
        id: queueId,
        currentNumber: queue.currentNumber,
        nextTicket: ticketNumber + 1,
        waitingCount: position,
      },
    });

    return c.json(
      {
        id: ticketId,
        number: ticketNumber,
        status: "waiting",
        position,
        queueId,
        estimatedWaitMinutes,
      },
      201,
    );
  });

  // Get ticket status (public)
  app.get("/:queueId/ticket/:ticketId", async (c) => {
    const queueId = parseInt(c.req.param("queueId"), 10);
    const ticketId = parseInt(c.req.param("ticketId"), 10);

    const [ticket] = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.id, ticketId),
          eq(schema.tickets.queueId, queueId),
        ),
      )
      .limit(1);

    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }

    // Calculate position if waiting
    let position: number | null = null;
    if (ticket.status === "waiting") {
      const waitingTickets = await (db as any)
        .select()
        .from(schema.tickets)
        .where(
          and(
            eq(schema.tickets.queueId, queueId),
            eq(schema.tickets.status, "waiting"),
          ),
        )
        .orderBy(schema.tickets.number);

      position = waitingTickets.findIndex((t: any) => t.id === ticketId) + 1;
    }

    // Estimate wait time
    const stats = await getQueueStats(db, schema, queueId);
    const estimatedWaitMinutes =
      position && stats.avgServiceTime > 0
        ? Math.round((position * stats.avgServiceTime) / 60)
        : null;

    return c.json({
      id: ticket.id,
      number: ticket.number,
      status: ticket.status,
      position,
      queueId: ticket.queueId,
      estimatedWaitMinutes,
    });
  });

  return app;
}
