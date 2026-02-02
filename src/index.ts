import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { createMysqlDb } from "./db/index.js";
import { createApp } from "./app.js";
import { setupWebSocket, createBroadcast } from "./websocket.js";
import { env } from "./env.js";

async function main() {
  // Initialize database
  const database = await createMysqlDb(env.DATABASE_URL);
  console.log("Connected to MySQL database");

  // WebSocket connections store
  const wsConnections = new Map<number, Set<WebSocket>>();
  const broadcast = createBroadcast(wsConnections);

  // Create Hono app
  const app = createApp(database, broadcast);

  // Start server with WebSocket support
  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    (info) => {
      console.log(`Server running at http://localhost:${info.port}`);
    },
  );

  // Setup WebSocket
  setupWebSocket(server as any, wsConnections);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    await database.close();
    process.exit(0);
  });
}

main().catch(console.error);
