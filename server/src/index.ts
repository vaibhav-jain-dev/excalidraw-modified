import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";

import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { sweepExpiredScenes } from "./store/scenes.ts";

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>excalidraw-local</title></head>
<body style="font:14px system-ui;margin:3rem auto;max-width:38rem;padding:0 1rem">
  <h1>excalidraw-local server</h1>
  <p>The API is running. The built app was not found at
     <code>${config.appBuildDir}</code>.</p>
  <ul>
    <li>Dev: run <code>yarn start</code> (Vite on :3056, proxies <code>/api</code> here).</li>
    <li>Prod: run <code>yarn build</code>, then restart this server.</li>
  </ul>
  <p>Health check: <a href="/api/health">/api/health</a></p>
</body>
</html>
`;

const app = buildApp();

const hasBuiltApp =
  config.serveApp && fs.existsSync(path.join(config.appBuildDir, "index.html"));

if (hasBuiltApp) {
  await app.register(fastifyStatic, {
    root: config.appBuildDir,
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "";
    if (url.startsWith("/api/") || url.startsWith("/mcp")) {
      return reply.code(404).send({ error: "not found" });
    }
    // SPA fallback — `/`, `/d/<id>`, …
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(PLACEHOLDER_PAGE);
  });
}

// reap expired temporary scenes — on startup, then every minute
const reap = () => {
  const removed = sweepExpiredScenes();
  if (removed > 0) {
    app.log.info({ removed }, "swept expired temporary scenes");
  }
};
reap();
const reaper = setInterval(reap, 60_000);
reaper.unref();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { dataDir: config.dataDir, servingApp: hasBuiltApp },
    "excalidraw-local server ready",
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
