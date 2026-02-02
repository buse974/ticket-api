import {
  mysqlTable,
  int,
  varchar,
  timestamp,
  text,
  boolean,
  mysqlEnum,
} from "drizzle-orm/mysql-core";

// ===========================================
// MySQL Schema - Byewait
// ===========================================

// Plans disponibles
export const planEnum = mysqlEnum("plan", ["free", "pro"]);

// Professionnels (comptes principaux/entreprises)
export const professionals = mysqlTable("professionals", {
  id: int("id").primaryKey().autoincrement(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  plan: varchar("plan", { length: 10 }).notNull().default("free"), // 'free' ou 'pro'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// Utilisateurs (employés des professionnels)
export const users = mysqlTable("users", {
  id: int("id").primaryKey().autoincrement(),
  professionalId: int("professional_id")
    .notNull()
    .references(() => professionals.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: mysqlEnum("role", ["owner", "staff"]).notNull().default("staff"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// Clients (comptes optionnels pour les utilisateurs finaux)
export const clients = mysqlTable("clients", {
  id: int("id").primaryKey().autoincrement(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// Files d'attente (multi-files par professionnel)
export const queues = mysqlTable("queues", {
  id: int("id").primaryKey().autoincrement(),
  professionalId: int("professional_id")
    .notNull()
    .references(() => professionals.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(), // ex: "Coupe Homme", "Coloration"
  slug: varchar("slug", { length: 100 }).notNull().unique(), // URL friendly, unique globalement
  currentNumber: int("current_number").notNull().default(0),
  nextTicket: int("next_ticket").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true), // file ouverte ou fermée
  allowRemoteBooking: boolean("allow_remote_booking").notNull().default(true), // réservation à distance
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// Statuts des tickets
export const ticketStatusEnum = mysqlEnum("ticket_status", [
  "waiting", // en attente
  "current", // en cours (appelé)
  "completed", // terminé
  "no_show", // absent
]);

// Tickets
export const tickets = mysqlTable("tickets", {
  id: int("id").primaryKey().autoincrement(),
  queueId: int("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  clientId: int("client_id").references(() => clients.id, {
    onDelete: "set null",
  }), // Optionnel
  number: int("number").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("waiting"), // waiting, current, completed, no_show

  // Tracking client
  clientIp: varchar("client_ip", { length: 45 }), // IPv6 max length
  isRemote: boolean("is_remote").notNull().default(false), // true si réservé à distance

  // Push notifications
  pushSubscription: text("push_subscription"),

  // Timestamps pour calcul des stats
  createdAt: timestamp("created_at").defaultNow().notNull(), // prise du ticket
  calledAt: timestamp("called_at"), // moment où le numéro est appelé (devient "current")
  completedAt: timestamp("completed_at"), // moment où terminé ou no_show
});

// Tracking anti-abus par IP (réservations à distance)
export const ipTracking = mysqlTable("ip_tracking", {
  id: int("id").primaryKey().autoincrement(),
  queueId: int("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  clientIp: varchar("client_ip", { length: 45 }).notNull(),
  ticketCount: int("ticket_count").notNull().default(1), // nombre de tickets pris ce jour
  date: varchar("date", { length: 10 }).notNull(), // format YYYY-MM-DD
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// Stats journalières par file (pour historique - plan Pro)
export const dailyStats = mysqlTable("daily_stats", {
  id: int("id").primaryKey().autoincrement(),
  queueId: int("queue_id")
    .notNull()
    .references(() => queues.id, { onDelete: "cascade" }),
  date: varchar("date", { length: 10 }).notNull(), // format YYYY-MM-DD

  // Compteurs
  totalTickets: int("total_tickets").notNull().default(0),
  completedTickets: int("completed_tickets").notNull().default(0),
  noShowTickets: int("no_show_tickets").notNull().default(0),
  remoteTickets: int("remote_tickets").notNull().default(0), // tickets pris à distance

  // Temps moyens en secondes
  avgWaitTime: int("avg_wait_time"), // temps moyen entre création et appelé
  avgServiceTime: int("avg_service_time"), // temps moyen entre appelé et terminé

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
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
  maxTicketsPerIpPerDay: 2, // max 2 tickets par IP par jour par file
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

// Types utilitaires
export type UserRole = "owner" | "staff";
export type TicketStatus = "waiting" | "current" | "completed" | "no_show";
export type PlanType = "free" | "pro";
