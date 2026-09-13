import fs from "node:fs";

import type { FastifyInstance, FastifyReply } from "fastify";

import type { SemanticScene } from "../derive/semantic.ts";
import { reportPresence, subscribeEvents, type LiveEvent } from "../events.ts";
import { ensureDir, thumbFile, thumbsDir } from "../paths.ts";
import { renderScenePng } from "../render/browser.ts";
import {
  appendSemantic,
  createScene,
  findAnchorBounds,
  getMarkdown,
  getMermaid,
  getSceneContent,
  getSceneSummary,
  getSemantic,
  listAnchors,
  listCategories,
  listScenes,
  listVersions,
  markThumbnailUpdated,
  refreshTempExpiry,
  saveScene,
  saveSceneFromSemantic,
  SceneNotFoundError,
  setElementAnchor,
  setVersionPinned,
  softDeleteScene,
  updateSceneMeta,
  type SceneContent,
} from "../store/scenes.ts";

interface SceneMetaBody {
  name?: string;
  description?: string;
  category?: string;
  folder?: string;
  tags?: string[];
  pinned?: boolean;
  temporary?: boolean;
}

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

interface IdParams {
  id: string;
}
interface VersionParams {
  id: string;
  version: string;
}

const notFound = (reply: FastifyReply, message = "scene not found") =>
  reply.code(404).send({ error: message });

const asContent = (body: unknown): Partial<SceneContent> => {
  const source = (body ?? {}) as Partial<SceneContent>;
  return {
    elements: Array.isArray(source.elements) ? source.elements : [],
    appState:
      source.appState && typeof source.appState === "object"
        ? source.appState
        : {},
    files:
      source.files && typeof source.files === "object" ? source.files : {},
  };
};

const parseVersion = (raw: string): number | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export const registerSceneRoutes = (app: FastifyInstance): void => {
  app.get("/api/scenes", async () => ({ scenes: listScenes() }));

  app.get("/api/categories", async () => ({ categories: listCategories() }));

  app.post("/api/scenes", async (request, reply) => {
    const body = (request.body ?? {}) as SceneMetaBody & {
      semantic?: Partial<SemanticScene>;
    };
    let scene = createScene({
      name: body.name,
      description: body.description,
      category: body.category,
      folder: body.folder,
      tags: body.tags,
      temporary: body.temporary === true,
    });
    if (body.semantic) {
      scene = saveSceneFromSemantic(scene.id, body.semantic).summary;
    }
    reply.code(201);
    return { scene };
  });

  app.get<{ Params: IdParams }>("/api/scenes/:id", async (request, reply) => {
    const summary = getSceneSummary(request.params.id);
    if (!summary) {
      return notFound(reply);
    }
    const content = getSceneContent(request.params.id);
    return { scene: summary, ...(content ?? { elements: [], appState: {}, files: {} }) };
  });

  app.put<{ Params: IdParams }>("/api/scenes/:id", async (request, reply) => {
    const clientId = request.headers["x-client-id"];
    try {
      const { version, summary } = saveScene(
        request.params.id,
        asContent(request.body),
        "editor",
        typeof clientId === "string" ? clientId : undefined,
      );
      return { scene: summary, version };
    } catch (error) {
      if (error instanceof SceneNotFoundError) {
        return notFound(reply, error.message);
      }
      throw error;
    }
  });

  // editor -> server: "this scene is open right now"
  app.post<{ Params: IdParams }>(
    "/api/scenes/:id/presence",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply);
      }
      const body = (request.body ?? {}) as { clientId?: string };
      reportPresence(request.params.id, body.clientId);
      refreshTempExpiry(request.params.id);
      return { ok: true };
    },
  );

  // server -> clients: live `scene-changed` stream (Server-Sent Events)
  app.get("/api/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");

    const send = (event: LiveEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    const unsubscribe = subscribeEvents(send);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    reply.hijack();
  });

  app.patch<{ Params: IdParams }>("/api/scenes/:id", async (request, reply) => {
    const body = (request.body ?? {}) as SceneMetaBody;
    try {
      return { scene: updateSceneMeta(request.params.id, body) };
    } catch (error) {
      if (error instanceof SceneNotFoundError) {
        return notFound(reply, error.message);
      }
      throw error;
    }
  });

  app.delete<{ Params: IdParams }>(
    "/api/scenes/:id",
    async (request, reply) => {
      if (!softDeleteScene(request.params.id)) {
        return notFound(reply);
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/versions",
    async (request, reply) => {
      try {
        return { versions: listVersions(request.params.id) };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: VersionParams }>(
    "/api/scenes/:id/versions/:version",
    async (request, reply) => {
      const version = parseVersion(request.params.version);
      if (version === null) {
        return reply.code(400).send({ error: "invalid version" });
      }
      const summary = getSceneSummary(request.params.id);
      if (!summary) {
        return notFound(reply);
      }
      const content = getSceneContent(request.params.id, version);
      if (!content) {
        return notFound(reply, "version not found");
      }
      return { scene: summary, version, ...content };
    },
  );

  app.post<{ Params: VersionParams }>(
    "/api/scenes/:id/versions/:version/pin",
    async (request, reply) => {
      const version = parseVersion(request.params.version);
      if (version === null) {
        return reply.code(400).send({ error: "invalid version" });
      }
      const body = (request.body ?? {}) as { pinned?: boolean };
      try {
        setVersionPinned(request.params.id, version, body.pinned !== false);
        return { ok: true };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  // --- semantic (bot-friendly) views ---

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/semantic",
    async (request, reply) => {
      const semantic = getSemantic(request.params.id);
      if (!semantic) {
        return notFound(reply);
      }
      return semantic;
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/markdown",
    async (request, reply) => {
      const markdown = getMarkdown(request.params.id);
      if (markdown == null) {
        return notFound(reply);
      }
      return reply.type("text/markdown").send(markdown);
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/mermaid",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply);
      }
      const mermaid = getMermaid(request.params.id);
      if (mermaid == null) {
        return reply
          .code(422)
          .send({ error: "scene has no nodes/edges to diagram" });
      }
      return reply.type("text/plain").send(mermaid);
    },
  );

  app.put<{ Params: IdParams }>(
    "/api/scenes/:id/semantic",
    async (request, reply) => {
      try {
        const { summary, version } = saveSceneFromSemantic(
          request.params.id,
          (request.body ?? {}) as Partial<SemanticScene>,
          "api",
        );
        return { scene: summary, version };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: IdParams }>(
    "/api/scenes/:id/semantic/append",
    async (request, reply) => {
      try {
        const { summary, version } = appendSemantic(
          request.params.id,
          (request.body ?? {}) as Partial<SemanticScene>,
          "api",
        );
        return { scene: summary, version };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  // --- thumbnails: rendered client-side on save, one PNG per scene ---

  app.put<{ Params: IdParams }>(
    "/api/scenes/:id/thumbnail",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply);
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected image bytes" });
      }
      if (body.length > MAX_THUMBNAIL_BYTES) {
        return reply.code(413).send({ error: "thumbnail too large" });
      }
      ensureDir(thumbsDir());
      fs.writeFileSync(thumbFile(request.params.id), body);
      markThumbnailUpdated(request.params.id);
      return { ok: true };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/thumbnail",
    async (request, reply) => {
      const file = thumbFile(request.params.id);
      if (!fs.existsSync(file)) {
        return reply.code(404).send({ error: "no thumbnail" });
      }
      return reply
        .type("image/png")
        .header("cache-control", "no-cache")
        .send(fs.readFileSync(file));
    },
  );

  // --- named anchors: `customData.anchor` on one element ---

  app.get<{ Params: IdParams }>(
    "/api/scenes/:id/anchors",
    async (request, reply) => {
      if (!getSceneSummary(request.params.id)) {
        return notFound(reply);
      }
      const anchors = listAnchors(request.params.id).map((entry) => ({
        ...entry,
        bounds: findAnchorBounds(request.params.id, entry.anchor),
      }));
      return { anchors };
    },
  );

  app.put<{ Params: { id: string; elementId: string } }>(
    "/api/scenes/:id/anchors/:elementId",
    async (request, reply) => {
      const body = (request.body ?? {}) as { anchor?: string | null };
      try {
        const ok = setElementAnchor(
          request.params.id,
          request.params.elementId,
          body.anchor?.trim() || null,
        );
        if (!ok) {
          return reply.code(404).send({ error: "no such element" });
        }
        return { ok: true };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  // --- server-side render: for a scene never opened in a browser (no
  // client-rendered thumbnail), or a crop to a named anchor ---

  app.get<{
    Params: IdParams;
    Querystring: { anchor?: string; width?: string; height?: string };
  }>("/api/scenes/:id/render.png", async (request, reply) => {
    if (!getSceneSummary(request.params.id)) {
      return notFound(reply);
    }
    try {
      const png = await renderScenePng(request.params.id, {
        anchor: request.query.anchor,
        width: request.query.width ? Number(request.query.width) : undefined,
        height: request.query.height
          ? Number(request.query.height)
          : undefined,
      });
      return reply
        .type("image/png")
        .header("cache-control", "no-cache")
        .send(png);
    } catch (error) {
      return reply
        .code(503)
        .send({ error: `render failed: ${(error as Error).message}` });
    }
  });
};
