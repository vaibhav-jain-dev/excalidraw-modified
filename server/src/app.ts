import Fastify, { type FastifyInstance } from "fastify";

import { config } from "./config.ts";
import { registerSceneRoutes } from "./routes/scenes.ts";

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

  registerSceneRoutes(app);

  return app;
};
