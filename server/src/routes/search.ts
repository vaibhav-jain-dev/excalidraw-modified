import type { FastifyInstance } from "fastify";

import { generateSemanticFromPrompt } from "../generate.ts";
import { searchScenes, type SearchMode } from "../search/index.ts";
import { isVectorSearchReady } from "../search/vector.ts";
import { createScene, saveSceneFromSemantic } from "../store/scenes.ts";

const MODES = new Set(["fts", "vector", "hybrid"]);

export const registerSearchRoutes = (app: FastifyInstance): void => {
  app.get<{ Querystring: { q?: string; mode?: string; limit?: string } }>(
    "/api/search",
    async (request, reply) => {
      const q = request.query.q?.trim();
      if (!q) {
        return { results: [] };
      }
      const mode: SearchMode = MODES.has(request.query.mode ?? "")
        ? (request.query.mode as SearchMode)
        : "hybrid";
      const limit = Math.min(Number(request.query.limit) || 20, 50);
      const results = await searchScenes(q, mode, limit);
      return { results, vectorAvailable: isVectorSearchReady() };
    },
  );

  app.get("/api/search/status", async () => ({
    vectorAvailable: isVectorSearchReady(),
  }));

  // text-to-diagram: local model (Ollama) only, best-effort
  app.post<{ Body: { prompt?: string; name?: string } }>(
    "/api/generate",
    async (request, reply) => {
      const prompt = request.body?.prompt?.trim();
      if (!prompt) {
        return reply.code(400).send({ error: "prompt is required" });
      }
      const result = await generateSemanticFromPrompt(prompt);
      if ("error" in result) {
        return reply.code(503).send({ error: result.error });
      }
      const scene = createScene({ name: request.body?.name || prompt.slice(0, 60) });
      saveSceneFromSemantic(scene.id, result.scene);
      return reply.code(201).send({ scene });
    },
  );
};
