import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  text,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

// ===========================================
// PostgreSQL Schema - Byewait
// ===========================================

// Enums
export const roleEnum = pgEnum("role", ["owner", "staff"]);
export const ticketStatusEnum = pgEnum("ticket_status", [
  "waiting",
  "current",
  "completed",
  "no_show",
]);

// Professionnels (comptes principaux/entreprises)
export const professionals = pgTable("professionals", {
  id: serial("id").primaryKey(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  plan: varchar("plan", { length: 10 }).notNull().default("free"), // 'free' ou 'pro'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Utilisateurs (employés des professionnels)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  professionalId: integer("professional_id")
    .notNull()
    .references(() => professionals.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: roleEnum("role").notNull().default("staff"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Clients (comptes optionnels pour les utilisateurs finaux)
export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Files d'attente (multi-files par professionnel)
export const queues = pgTable("queues", {
  id: serial("id").primaryKey(),
  professionalId: integer("professional_id")
    .notNull()
    .references(() => professionals.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  currentNumber: integer("current_number").notNull().default(0),
  nextTicket: integer("next_ticket").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  allowRemoteBooking: boolean("allow_remote_booking").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Tickets
export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  queueId: integer("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  clientId: integer("client_id").references(() => clients.id, {
    onDelete: "set null",
  }),
  number: integer("number").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("waiting"),
  clientIp: varchar("client_ip", { length: 45 }),
  isRemote: boolean("is_remote").notNull().default(false),
  pushSubscription: text("push_subscription"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  calledAt: timestamp("called_at"),
  completedAt: timestamp("completed_at"),
});

// Tracking anti-abus par IP
export const ipTracking = pgTable("ip_tracking", {
  id: serial("id").primaryKey(),
  queueId: integer("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  clientIp: varchar("client_ip", { length: 45 }).notNull(),
  ticketCount: integer("ticket_count").notNull().default(1),
  date: varchar("date", { length: 10 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Stats journalières par file
export const dailyStats = pgTable("daily_stats", {
  id: serial("id").primaryKey(),
  queueId: integer("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  date: varchar("date", { length: 10 }).notNull(),
  totalTickets: integer("total_tickets").notNull().default(0),
  completedTickets: integer("completed_tickets").notNull().default(0),
  noShowTickets: integer("no_show_tickets").notNull().default(0),
  remoteTickets: integer("remote_tickets").notNull().default(0),
  avgWaitTime: integer("avg_wait_time"),
  avgServiceTime: integer("avg_service_time"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ===========================================
// Constantes Business
// ===========================================

export const PLAN_LIMITS = {
  free: {
    maxQueues: 1,
    maxTicketsPerDay: 40,
  },
  pro: {
    maxQueues: Infinity,
    maxTicketsPerDay: Infinity,
  },
} as const;

export const ANTI_ABUSE_LIMITS = {
  maxTicketsPerIpPerDay: 2,
} as const;

// ===========================================
// Type exports
// ===========================================

export type Professional = typeof professionals.$inferSelect;
export type NewProfessional = typeof professionals.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;

export type Queue = typeof queues.$inferSelect;
export type NewQueue = typeof queues.$inferInsert;

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

export type IpTracking = typeof ipTracking.$inferSelect;
export type NewIpTracking = typeof ipTracking.$inferInsert;

export type DailyStat = typeof dailyStats.$inferSelect;
export type NewDailyStat = typeof dailyStats.$inferInsert;

export type UserRole = "owner" | "staff";
export type TicketStatus = "waiting" | "current" | "completed" | "no_show";
export type PlanType = "free" | "pro";
