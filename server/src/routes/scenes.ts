import fs from "node:fs";

import type { FastifyInstance, FastifyReply } from "fastify";

import { ensureDir, thumbFile, thumbsDir } from "../paths.ts";
import {
  createScene,
  getSceneContent,
  getSceneSummary,
  listCategories,
  listScenes,
  listVersions,
  markThumbnailUpdated,
  saveScene,
  SceneNotFoundError,
  setVersionPinned,
  softDeleteScene,
  updateSceneMeta,
  type SceneContent,
} from "../store/scenes.ts";

interface SceneMetaBody {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  pinned?: boolean;
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
    const body = (request.body ?? {}) as SceneMetaBody;
    const scene = createScene({
      name: body.name,
      description: body.description,
      category: body.category,
      tags: body.tags,
    });
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
    try {
      const { version, summary } = saveScene(
        request.params.id,
        asContent(request.body),
        "api",
      );
      return { scene: summary, version };
    } catch (error) {
      if (error instanceof SceneNotFoundError) {
        return notFound(reply, error.message);
      }
      throw error;
    }
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
};
