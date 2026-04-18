import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, count, sql, gte, lte, asc, desc } from "drizzle-orm";
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

// Helper: resolve period string to {from, to} dates (inclusive start, exclusive end)
function resolvePeriod(period: string): { from: Date; to: Date; days: number } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCHours(0, 0, 0, 0);
  to.setUTCHours(0, 0, 0, 0);
  to.setUTCDate(to.getUTCDate() + 1); // exclusive end = tomorrow 00:00

  let days = 1;
  if (period === "7d") {
    days = 7;
    from.setUTCDate(from.getUTCDate() - 6); // 7 days including today
  } else if (period === "30d") {
    days = 30;
    from.setUTCDate(from.getUTCDate() - 29);
  }

  return { from, to, days };
}

// Helper: format date as YYYY-MM-DD (UTC)
function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Helper: aggregate tickets into daily stats for a period
async function getStatsRange(
  db: any,
  schema: any,
  queueId: number,
  period: string,
) {
  const { from, to, days } = resolvePeriod(period);

  const tickets = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.queueId, queueId),
        gte(schema.tickets.createdAt, from),
        lte(schema.tickets.createdAt, to),
      ),
    );

  // Initialize buckets for each day
  const buckets: Record<
    string,
    {
      date: string;
      total: number;
      completed: number;
      noShow: number;
      cancelled: number;
      waitTimes: number[];
      serviceTimes: number[];
    }
  > = {};

  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setUTCDate(from.getUTCDate() + i);
    const key = formatDate(d);
    buckets[key] = {
      date: key,
      total: 0,
      completed: 0,
      noShow: 0,
      cancelled: 0,
      waitTimes: [],
      serviceTimes: [],
    };
  }

  let totalWaitTimes: number[] = [];
  let totalServiceTimes: number[] = [];
  let total = 0;
  let completed = 0;
  let noShow = 0;
  let cancelled = 0;

  for (const t of tickets) {
    const key = formatDate(new Date(t.createdAt));
    const bucket = buckets[key];
    if (!bucket) continue;

    bucket.total++;
    total++;

    if (t.status === "completed") {
      bucket.completed++;
      completed++;
    } else if (t.status === "no_show") {
      bucket.noShow++;
      noShow++;
    } else if (t.status === "cancelled") {
      bucket.cancelled++;
      cancelled++;
    }

    if (t.calledAt && t.createdAt) {
      const waitSec =
        (new Date(t.calledAt).getTime() - new Date(t.createdAt).getTime()) /
        1000;
      if (waitSec >= 0) {
        bucket.waitTimes.push(waitSec);
        totalWaitTimes.push(waitSec);
      }
    }
    if (t.completedAt && t.calledAt && t.status === "completed") {
      const serviceSec =
        (new Date(t.completedAt).getTime() -
          new Date(t.calledAt).getTime()) /
        1000;
      if (serviceSec >= 0) {
        bucket.serviceTimes.push(serviceSec);
        totalServiceTimes.push(serviceSec);
      }
    }
  }

  const avg = (arr: number[]) =>
    arr.length > 0
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
      : 0;

  const daily = Object.values(buckets)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({
      date: b.date,
      total: b.total,
      completed: b.completed,
      noShow: b.noShow,
      cancelled: b.cancelled,
      avgWaitTime: avg(b.waitTimes),
      avgServiceTime: avg(b.serviceTimes),
    }));

  const toExclusive = new Date(to);
  toExclusive.setUTCDate(toExclusive.getUTCDate() - 1);

  return {
    range: {
      from: formatDate(from),
      to: formatDate(toExclusive),
      period,
    },
    totals: {
      totalTickets: total,
      completed,
      noShow,
      cancelled,
      avgWaitTime: avg(totalWaitTimes),
      avgServiceTime: avg(totalServiceTimes),
      noShowRate: total > 0 ? Math.round((noShow / total) * 100) : 0,
    },
    daily,
  };
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
    noShowRate: totalToday > 0 ? Math.round((noShow / totalToday) * 100) : 0,
    avgWaitTime,
    avgServiceTime,
    estimatedEndTime,
  };
}

export function createQueueRoutes(database: Database, broadcast: BroadcastFn) {
  const app = new Hono();
  const { db, schema } = database;

  // Helper: get professionalId from userId (JWT sub contains userId)
  async function getProfessionalId(userId: number): Promise<number | null> {
    const [user] = await (db as any)
      .select({ professionalId: schema.users.professionalId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return user?.professionalId ?? null;
  }

  // ============================================
  // AUTHENTICATED ROUTES (Professional)
  // ============================================

  // Get all queues for authenticated professional
  app.get("/", jwtMiddleware, async (c) => {
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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
      const userId = parseInt(payload.sub as string, 10);
      const professionalId = await getProfessionalId(userId);
      if (!professionalId) {
        return c.json({ error: "User not found" }, 401);
      }
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
      const [newQueue] = await (db as any)
        .insert(schema.queues)
        .values({
          professionalId,
          name,
          slug,
          currentNumber: 0,
          nextTicket: 1,
          isActive: true,
        })
        .returning({ id: schema.queues.id });

      const queueId = newQueue.id;

      return c.json(
        {
          id: queueId,
          name,
          slug,
          currentNumber: 0,
          nextTicket: 1,
          isActive: true,
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
      const userId = parseInt(payload.sub as string, 10);
      const professionalId = await getProfessionalId(userId);
      if (!professionalId) {
        return c.json({ error: "User not found" }, 401);
      }
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
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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

  // Get queue stats (today by default, or extended over a period)
  app.get("/:id/stats", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const period = c.req.query("period");
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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

    // Extended range format (7d, 30d)
    if (period === "7d" || period === "30d") {
      const range = await getStatsRange(db, schema, queueId, period);
      return c.json(range);
    }

    // Default: legacy today format (backwards compatible)
    const stats = await getQueueStats(db, schema, queueId);
    return c.json(stats);
  });

  // Get queue history (past tickets, paginated)
  app.get("/:id/history", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const period = c.req.query("period") ?? "7d";
    const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Math.min(
      Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100),
      500,
    );
    const offset = Math.max(
      0,
      Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    );

    if (period !== "7d" && period !== "30d") {
      return c.json({ error: "Invalid period (7d or 30d)" }, 400);
    }

    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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

    const { from, to } = resolvePeriod(period);

    const [totalResult] = await (db as any)
      .select({ count: count() })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          gte(schema.tickets.createdAt, from),
          lte(schema.tickets.createdAt, to),
        ),
      );

    const rows = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          gte(schema.tickets.createdAt, from),
          lte(schema.tickets.createdAt, to),
        ),
      )
      .orderBy(desc(schema.tickets.createdAt))
      .limit(limit)
      .offset(offset);

    const tickets = rows.map((t: any) => {
      let waitTime: number | null = null;
      let serviceTime: number | null = null;
      if (t.calledAt && t.createdAt) {
        waitTime = Math.round(
          (new Date(t.calledAt).getTime() -
            new Date(t.createdAt).getTime()) /
            1000,
        );
      }
      if (t.completedAt && t.calledAt && t.status === "completed") {
        serviceTime = Math.round(
          (new Date(t.completedAt).getTime() -
            new Date(t.calledAt).getTime()) /
            1000,
        );
      }
      return {
        id: t.id,
        number: t.number,
        status: t.status,
        createdAt: t.createdAt,
        calledAt: t.calledAt,
        completedAt: t.completedAt,
        isRemote: t.isRemote,
        waitTime,
        serviceTime,
      };
    });

    return c.json({
      tickets,
      total: Number(totalResult?.count ?? 0),
      limit,
      offset,
    });
  });

  // Helper: close a specific current ticket with given status and optionally call next
  async function closeTicketAndMaybeCallNext(
    c: any,
    queueId: number,
    ticketId: number,
    closeStatus: "completed" | "no_show",
  ) {
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

    // Verify queue ownership
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

    // Fetch the ticket and validate it belongs to the queue + is current
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

    if (ticket.status !== "current") {
      return c.json({ error: "Ticket is not current" }, 400);
    }

    // Update ticket to its closing status
    await (db as any)
      .update(schema.tickets)
      .set({ status: closeStatus, completedAt: new Date() })
      .where(eq(schema.tickets.id, ticket.id));

    const closedTicket = {
      ...ticket,
      status: closeStatus,
      completedAt: new Date(),
    };

    // Broadcast completion (keeps existing event name for client compatibility)
    broadcast(queueId, {
      type: "ticket:completed",
      payload: { id: closedTicket.id, number: closedTicket.number },
    });

    // Optionally pick the next waiting ticket
    let nextTicket: any = null;
    const wantNext = c.req.query("next") === "true";
    if (wantNext) {
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

      if (waitingTickets.length > 0) {
        const next = waitingTickets[0];
        const now = new Date();
        await (db as any)
          .update(schema.tickets)
          .set({ status: "current", calledAt: now })
          .where(eq(schema.tickets.id, next.id));

        await (db as any)
          .update(schema.queues)
          .set({ currentNumber: next.number })
          .where(eq(schema.queues.id, queueId));

        nextTicket = { ...next, status: "current", calledAt: now };

        if (next.pushSubscription) {
          await sendPushNotification(next.pushSubscription, {
            title: "C'est votre tour !",
            body: `Ticket n°${next.number} - Présentez-vous maintenant`,
            ticketNumber: next.number,
          });
        }

        broadcast(queueId, {
          type: "ticket:called",
          payload: { id: next.id, number: next.number },
        });
      }
    }

    const stats = await getQueueStats(db, schema, queueId);
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return { closedTicket, nextTicket, stats };
  }

  // Complete a specific current ticket (per-ticket API for multi-current support)
  app.post("/:id/ticket/:ticketId/complete", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const ticketId = parseInt(c.req.param("ticketId"), 10);
    if (!Number.isFinite(queueId) || !Number.isFinite(ticketId)) {
      return c.json({ error: "Invalid parameters" }, 400);
    }

    const result = await closeTicketAndMaybeCallNext(
      c,
      queueId,
      ticketId,
      "completed",
    );

    // Error response already returned as c.json(...)
    if (!("closedTicket" in (result as any))) {
      return result as any;
    }

    const { closedTicket, nextTicket, stats } = result as any;
    return c.json({ completedTicket: closedTicket, nextTicket, stats });
  });

  // Mark a specific current ticket as no-show (per-ticket API for multi-current support)
  app.post("/:id/ticket/:ticketId/no-show", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const ticketId = parseInt(c.req.param("ticketId"), 10);
    if (!Number.isFinite(queueId) || !Number.isFinite(ticketId)) {
      return c.json({ error: "Invalid parameters" }, 400);
    }

    const result = await closeTicketAndMaybeCallNext(
      c,
      queueId,
      ticketId,
      "no_show",
    );

    if (!("closedTicket" in (result as any))) {
      return result as any;
    }

    const { closedTicket, nextTicket, stats } = result as any;
    return c.json({ noShowTicket: closedTicket, nextTicket, stats });
  });

  // Call next ticket (without completing current)
  app.post("/:id/call-next", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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
      payload: { id: next.id, number: next.number },
    });
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return c.json({ currentTicket: { ...next, status: "current" }, stats });
  });

  // Call a specific ticket by id (multi-serving)
  app.post("/:id/ticket/:ticketId/call", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const ticketId = parseInt(c.req.param("ticketId"), 10);
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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

    // Get the specific ticket
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

    if (ticket.status !== "waiting") {
      return c.json({ error: "Ticket not waiting" }, 400);
    }

    // Update ticket to current
    await (db as any)
      .update(schema.tickets)
      .set({ status: "current", calledAt: new Date() })
      .where(eq(schema.tickets.id, ticket.id));

    // Update queue current number
    await (db as any)
      .update(schema.queues)
      .set({ currentNumber: ticket.number })
      .where(eq(schema.queues.id, queueId));

    // Send push notification
    if (ticket.pushSubscription) {
      await sendPushNotification(ticket.pushSubscription, {
        title: "C'est votre tour !",
        body: `Ticket n°${ticket.number} - Présentez-vous maintenant`,
        ticketNumber: ticket.number,
      });
    }

    const stats = await getQueueStats(db, schema, queueId);
    broadcast(queueId, {
      type: "ticket:called",
      payload: { id: ticket.id, number: ticket.number },
    });
    broadcast(queueId, { type: "queue:update", payload: { queueId, stats } });

    return c.json({ currentTicket: { ...ticket, status: "current" }, stats });
  });

  // Reset queue (delete all tickets, reset counters)
  app.post("/:id/reset", jwtMiddleware, async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const payload = c.get("jwtPayload");
    const userId = parseInt(payload.sub as string, 10);
    const professionalId = await getProfessionalId(userId);
    if (!professionalId) {
      return c.json({ error: "User not found" }, 401);
    }

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

    // Get all current tickets (oldest called first) for multi-current support
    const currentRows = await (db as any)
      .select({ number: schema.tickets.number })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "current"),
        ),
      )
      .orderBy(asc(schema.tickets.calledAt));
    const currentNumbers = currentRows.map((t: any) => t.number);

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
      currentNumbers,
      nextTicket: queue.nextTicket,
      waitingCount: Number(waitingResult?.count ?? 0),
      isActive: queue.isActive,
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

    // Get all current tickets (oldest called first) for multi-current support
    const currentRows = await (db as any)
      .select({ number: schema.tickets.number })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.queueId, queue.id),
          eq(schema.tickets.status, "current"),
        ),
      )
      .orderBy(asc(schema.tickets.calledAt));
    const currentNumbers = currentRows.map((t: any) => t.number);

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
      currentNumbers,
      nextTicket: queue.nextTicket,
      waitingCount: Number(waitingResult?.count ?? 0),
      isActive: queue.isActive,
      professionalName: professional?.name || "Unknown",
    });
  });

  // Take a ticket (public)
  app.post("/:id/ticket", zValidator("json", takeTicketSchema), async (c) => {
    const queueId = parseInt(c.req.param("id"), 10);
    const { pushSubscription } = c.req.valid("json");
    const clientIp =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";

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

    const ticketNumber = queue.nextTicket;

    // Create ticket
    const [newTicket] = await (db as any)
      .insert(schema.tickets)
      .values({
        queueId,
        number: ticketNumber,
        status: "waiting",
        clientIp,
        isRemote: false,
        pushSubscription: pushSubscription || null,
      })
      .returning({ id: schema.tickets.id });

    const ticketId = newTicket.id;

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
        queueId,
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

  // Cancel ticket (public)
  app.post("/:queueId/ticket/:ticketId/cancel", async (c) => {
    const queueId = parseInt(c.req.param("queueId"), 10);
    const ticketId = parseInt(c.req.param("ticketId"), 10);

    const [ticket] = await (db as any)
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.id, ticketId),
          eq(schema.tickets.queueId, queueId),
          eq(schema.tickets.status, "waiting"),
        ),
      )
      .limit(1);

    if (!ticket) {
      return c.json({ error: "Ticket not found or not cancellable" }, 404);
    }

    await (db as any)
      .update(schema.tickets)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(schema.tickets.id, ticketId));

    broadcast(queueId, { type: "queue:update", payload: { queueId } });

    return c.json({ success: true });
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
