export const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "Qless API",
    version: "1.0.0",
    description: "API pour la gestion de files d'attente",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Development",
    },
    {
      url: "https://api.qless.51.77.223.61.nip.io",
      description: "Production",
    },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "API is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/auth/register": {
      post: {
        summary: "Register a new professional",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password", "businessName"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 6 },
                  businessName: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Professional registered successfully" },
          "400": { description: "Validation error" },
          "409": { description: "Email already exists" },
        },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Login",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Login successful",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    professional: { type: "object" },
                  },
                },
              },
            },
          },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/api/queue/{queueId}/join": {
      post: {
        summary: "Join a queue",
        tags: ["Queue"],
        parameters: [
          {
            name: "queueId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  phone: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Joined queue successfully" },
          "404": { description: "Queue not found" },
        },
      },
    },
    "/api/queue/{queueId}/entries": {
      get: {
        summary: "Get queue entries",
        tags: ["Queue"],
        parameters: [
          {
            name: "queueId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "List of queue entries",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                      position: { type: "integer" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/queue/{id}/stats": {
      get: {
        summary: "Get stats for a queue (today or over 7d/30d)",
        tags: ["Queue"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
          {
            name: "period",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["today", "7d", "30d"] },
            description:
              "Period (defaults to today, legacy flat format). 7d/30d returns {range, totals, daily[]}.",
          },
        ],
        responses: {
          "200": { description: "Stats object" },
          "401": { description: "Unauthorized" },
          "404": { description: "Queue not found" },
        },
      },
    },
    "/api/queue/{id}/history": {
      get: {
        summary: "Get past tickets of a queue, paginated",
        tags: ["Queue"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
          {
            name: "period",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["7d", "30d"], default: "7d" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": {
            description: "Paginated list of tickets",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tickets: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "integer" },
                          number: { type: "integer" },
                          status: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
                          calledAt: {
                            type: "string",
                            format: "date-time",
                            nullable: true,
                          },
                          completedAt: {
                            type: "string",
                            format: "date-time",
                            nullable: true,
                          },
                          isRemote: { type: "boolean" },
                          waitTime: { type: "integer", nullable: true },
                          serviceTime: { type: "integer", nullable: true },
                        },
                      },
                    },
                    total: { type: "integer" },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid period" },
          "401": { description: "Unauthorized" },
          "404": { description: "Queue not found" },
        },
      },
    },
    "/api/professional/queues": {
      get: {
        summary: "Get professional's queues",
        tags: ["Professional"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "List of queues" },
          "401": { description: "Unauthorized" },
        },
      },
      post: {
        summary: "Create a new queue",
        tags: ["Professional"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Queue created successfully" },
          "401": { description: "Unauthorized" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
  },
};
