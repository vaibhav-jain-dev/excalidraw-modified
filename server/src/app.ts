import Fastify, { type FastifyInstance } from "fastify";

import { config } from "./config.ts";
import { handleMcpHttp } from "./mcp/server.ts";
import { registerCommentRoutes } from "./routes/comments.ts";
import { registerGraphRoutes } from "./routes/graph.ts";
import { registerSceneRoutes } from "./routes/scenes.ts";
import { registerSearchRoutes } from "./routes/search.ts";

/**
 * Builds the Fastify instance with the API routes registered. Static hosting of
 * the built Excalidraw app and the MCP/WS endpoints are wired in `index.ts` so
 * this stays trivially testable.
 */
export const buildApp = (): FastifyInstance => {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimitBytes,
  });

  // raw bytes for thumbnail uploads (PUT /api/scenes/:id/thumbnail)
  app.addContentTypeParser(
    ["image/png", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.get("/api/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
  }));

  // Model Context Protocol — Streamable HTTP transport (stateless, JSON replies)
  app.post("/mcp", async (request, reply) => {
    const response = await handleMcpHttp(request.body);
    if (response === null) {
      return reply.code(202).send();
    }
    return reply.type("application/json").send(response);
  });
  app.get("/mcp", async (_request, reply) =>
    reply.code(405).send({ error: "Use POST for MCP messages" }),
  );

  registerSceneRoutes(app);
  registerSearchRoutes(app);
  registerCommentRoutes(app);
  registerGraphRoutes(app);

  return app;
};
