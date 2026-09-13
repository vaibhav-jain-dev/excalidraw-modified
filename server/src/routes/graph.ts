import type { FastifyInstance, FastifyReply } from "fastify";

import { status as indexStatus } from "../index-queue.ts";

import {
  buildTemplate,
  listTemplates,
  UnknownTemplateError,
} from "../derive/templates.ts";

import {
  annotate,
  clearAnnotations,
  describeScene,
  getTag,
  linksFrom,
  linksTo,
  listTags,
  neighbours,
  sceneNode,
  stats,
} from "../store/graph.ts";
import {
  getOutline,
  getOutlineSummary,
  getSceneSummary,
  linkScene,
  rebuildGraph,
  setElementTags,
} from "../store/scenes.ts";

interface SceneIdParams {
  id: string;
}

const notFound = (reply: FastifyReply, message = "not found") =>
  reply.code(404).send({ error: message });

export const registerGraphRoutes = (app: FastifyInstance): void => {
  app.get<{
    Params: SceneIdParams;
    Querystring: { summary?: string; bbox?: string };
  }>("/api/scenes/:id/outline", async (request, reply) => {
    const summaryOnly =
      request.query.summary === "1" || request.query.summary === "true";
    let region: [number, number, number, number] | undefined;
    if (request.query.bbox) {
      const parts = request.query.bbox.split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        return reply.code(400).send({ error: "bbox must be x,y,width,height" });
      }
      region = parts as [number, number, number, number];
    }
    const result = summaryOnly
      ? getOutlineSummary(request.params.id, region)
      : getOutline(request.params.id, region);
    return result ?? notFound(reply, "scene not found");
  });

  app.get<{ Params: SceneIdParams }>(
    "/api/scenes/:id/facts",
    async (request, reply) =>
      describeScene(request.params.id) ??
      notFound(reply, "the graph has not seen that drawing"),
  );

  // what an LLM worked out by looking at the rendered image
  app.post<{ Params: SceneIdParams }>(
    "/api/scenes/:id/annotate",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply, "scene not found");
      }
      const body = (request.body ?? {}) as { tags?: unknown; note?: unknown };
      return annotate(request.params.id, {
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        note: typeof body.note === "string" ? body.note : undefined,
      });
    },
  );

  app.delete<{ Params: SceneIdParams }>(
    "/api/scenes/:id/annotate",
    async (request) => ({ removed: clearAnnotations(request.params.id) }),
  );

  app.get("/api/templates", async () => ({ templates: listTemplates() }));

  // build a template without saving it — lets a caller preview the layout
  app.post<{ Params: { name: string } }>(
    "/api/templates/:name",
    async (request, reply) => {
      try {
        return buildTemplate(
          request.params.name,
          (request.body ?? {}) as Record<string, unknown>,
        );
      } catch (error) {
        if (error instanceof UnknownTemplateError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get("/api/tags", async () => ({ tags: listTags() }));

  app.get<{ Params: { tag: string } }>("/api/tags/:tag", async (request) => ({
    tag: getTag(decodeURIComponent(request.params.tag)),
  }));

  app.get("/api/graph/stats", async () => stats());

  app.get("/api/index/status", async () => indexStatus());

  app.get<{
    Querystring: { node?: string; scene?: string; tag?: string; hops?: string };
  }>("/api/graph/neighbours", async (request, reply) => {
    const { node, scene, tag } = request.query;
    const start = node ?? (scene ? `scene:${scene}` : tag ? `tag:${tag}` : null);
    if (!start) {
      return reply
        .code(400)
        .send({ error: "pass one of node, scene or tag" });
    }
    const hops = Math.min(4, Math.max(1, Number(request.query.hops) || 1));
    return { start, hops, neighbours: neighbours(start, hops) };
  });

  app.post("/api/graph/rebuild", async () => rebuildGraph());

  app.put<{ Params: { id: string; elementId: string } }>(
    "/api/scenes/:id/elements/:elementId/tags",
    async (request, reply) => {
      const body = (request.body ?? {}) as { tags?: unknown };
      if (!Array.isArray(body.tags)) {
        return reply.code(400).send({ error: "tags must be an array" });
      }
      const result = setElementTags(
        request.params.id,
        request.params.elementId,
        body.tags as string[],
      );
      if (!result) {
        return notFound(reply, "scene or element not found");
      }
      return result;
    },
  );

  app.get<{ Params: SceneIdParams }>(
    "/api/scenes/:id/links",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply, "scene not found");
      }
      return {
        out: linksFrom(request.params.id),
        in: linksTo(request.params.id),
        node: sceneNode(request.params.id),
      };
    },
  );

  app.post<{ Params: SceneIdParams }>(
    "/api/scenes/:id/links",
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        targetSceneId?: string;
        render?: string;
        x?: number;
        y?: number;
      };
      if (!body.targetSceneId) {
        return reply.code(400).send({ error: "targetSceneId is required" });
      }
      const at =
        typeof body.x === "number" && typeof body.y === "number"
          ? { x: body.x, y: body.y }
          : undefined;
      const result = linkScene(
        request.params.id,
        body.targetSceneId,
        body.render === "title" ? "title" : "embed",
        at,
      );
      if (!result) {
        return notFound(reply, "scene or target not found");
      }
      reply.code(201);
      return result;
    },
  );
};
