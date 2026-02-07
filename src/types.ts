// Ticket statuses
export type TicketStatus = "waiting" | "current" | "completed" | "no_show";

// Plan types
export type PlanType = "free" | "pro";

// API Response types
export interface QueueInfo {
  id: number;
  name?: string;
  slug?: string;
  currentNumber: number;
  nextTicket: number;
  waitingCount: number;
  isActive?: boolean;
}

export interface QueueStats {
  totalToday: number;
  completed: number;
  noShow: number;
  waiting: number;
  noShowRate: number;
  avgWaitTime: number; // en secondes
  avgServiceTime: number; // en secondes
  estimatedEndTime: string | null;
}

export interface QueueWithStats extends QueueInfo {
  stats: QueueStats;
}

export interface TicketInfo {
  id: number;
  number: number;
  status: TicketStatus;
  position: number | null;
  queueId: number;
  estimatedWaitMinutes?: number | null;
}

export interface ProfessionalInfo {
  id: number;
  email: string;
  name: string;
  plan: PlanType;
}

// WebSocket event types
export type WSEventType = "queue:update" | "ticket:called" | "ticket:completed" | "ticket:next";

export interface WSMessage {
  type: WSEventType;
  payload: Record<string, any>;
}

// API Request types
export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  professional: ProfessionalInfo;
}

export interface TakeTicketRequest {
  pushSubscription?: string;
}

export interface CreateQueueRequest {
  name: string;
}

export interface UpdateQueueRequest {
  name?: string;
  isActive?: boolean;
}

// Push notification payload
export interface PushPayload {
  title: string;
  body: string;
  ticketNumber: number;
}
