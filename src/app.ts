import { Hono } from "hono";
import { cors } from "hono/cors";
import { apiReference } from "@scalar/hono-api-reference";
import { createAuthRoutes } from "./routes/auth.js";
import { createQueueRoutes, type BroadcastFn } from "./routes/queue.js";
import { createProfessionalRoutes } from "./routes/professional.js";
import type { Database } from "./db/index.js";
import { openApiSpec } from "./openapi.js";

export function createApp(database: Database, broadcast: BroadcastFn) {
  const app = new Hono();

  // Middleware
  app.use(
    "*",
    cors({
      origin: [
        // Development
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        // Production
        "https://app.qless.51.77.223.61.nip.io",
        "https://qless.51.77.223.61.nip.io",
        "https://app.byewait.fr",
        "https://byewait.fr",
        "https://www.byewait.fr",
      ],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI spec
  app.get("/openapi.json", (c) => c.json(openApiSpec));

  // API Documentation (Swagger UI alternative)
  app.get(
    "/docs",
    apiReference({
      url: "/openapi.json",
    }),
  );

  // Routes
  app.route("/api/auth", createAuthRoutes(database));
  app.route("/api/queue", createQueueRoutes(database, broadcast));
  app.route("/api/professional", createProfessionalRoutes(database));

  return app;
}
