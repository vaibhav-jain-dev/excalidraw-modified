import type { FastifyInstance, FastifyReply } from "fastify";

import {
  createScene,
  getSceneContent,
  getSceneSummary,
  listScenes,
  listVersions,
  saveScene,
  SceneNotFoundError,
  setVersionPinned,
  softDeleteScene,
  updateSceneMeta,
  type SceneContent,
} from "../store/scenes.ts";

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

  app.post("/api/scenes", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; tags?: string[] };
    const scene = createScene({ name: body.name, tags: body.tags });
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
    const body = (request.body ?? {}) as {
      name?: string;
      tags?: string[];
      pinned?: boolean;
    };
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
};
