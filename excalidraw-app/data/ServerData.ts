/**
 * Client for the excalidraw-local server (see ../../LOCAL_FIRST_PLAN.md). In dev
 * the Vite dev server proxies `/api` to the Fastify server on :3057; in
 * production that same server hosts this app, so the relative path just works.
 */

import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

const API = "/api";

/** Stable per-tab id so the editor can ignore the echo of its own saves. */
export const CLIENT_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export interface RemoteSceneSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  elementCount: number;
  pinned: boolean;
  hasThumbnail: boolean;
  temporary: boolean;
  expiresAt: string | null;
}

export interface RemoteVersionInfo {
  version: number;
  createdAt: string;
  elementCount: number;
  pinned: boolean;
  source: string;
}

export interface RemoteSceneMeta {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  pinned?: boolean;
  temporary?: boolean;
}

export interface RemoteCommentMessage {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface RemoteCommentThread {
  id: string;
  sceneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
  messages: RemoteCommentMessage[];
}

const asJSON = async (response: Response) => {
  if (!response.ok) {
    throw new Error(
      `excalidraw-local ${response.status}: ${await response
        .text()
        .catch(() => response.statusText)}`,
    );
  }
  return response.json();
};

const jsonHeaders = { "content-type": "application/json" };

export const ServerData = {
  /** Whether the local server is reachable (used to decide dashboard vs editor-only). */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${API}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async listScenes(): Promise<RemoteSceneSummary[]> {
    return (await asJSON(await fetch(`${API}/scenes`))).scenes;
  },

  async listCategories(): Promise<string[]> {
    return (await asJSON(await fetch(`${API}/categories`))).categories;
  },

  /** Full-text (+ embedding similarity, when available) search across scenes. */
  async search(query: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      snippet?: string;
    }>
  > {
    if (!query.trim()) {
      return [];
    }
    return (
      await asJSON(await fetch(`${API}/search?q=${encodeURIComponent(query)}`))
    ).results;
  },

  async getScene(id: string): Promise<{
    scene: RemoteSceneSummary;
    elements: ImportedDataState["elements"];
    appState: ImportedDataState["appState"];
    files: ImportedDataState["files"];
  }> {
    return asJSON(await fetch(`${API}/scenes/${encodeURIComponent(id)}`));
  },

  async createScene(meta: RemoteSceneMeta = {}): Promise<RemoteSceneSummary> {
    return (
      await asJSON(
        await fetch(`${API}/scenes`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(meta),
        }),
      )
    ).scene;
  },

  async updateMeta(
    id: string,
    patch: RemoteSceneMeta,
  ): Promise<RemoteSceneSummary> {
    return (
      await asJSON(
        await fetch(`${API}/scenes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(patch),
        }),
      )
    ).scene;
  },

  async deleteScene(id: string): Promise<void> {
    await fetch(`${API}/scenes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async saveScene(
    id: string,
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ): Promise<void> {
    await fetch(`${API}/scenes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "x-client-id": CLIENT_ID },
      body: serializeAsJSON(elements, appState, files, "local"),
    });
  },

  async reportPresence(id: string): Promise<void> {
    try {
      await fetch(`${API}/scenes/${encodeURIComponent(id)}/presence`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
    } catch {
      // presence is best-effort
    }
  },

  async listVersions(id: string): Promise<RemoteVersionInfo[]> {
    return (
      await asJSON(
        await fetch(`${API}/scenes/${encodeURIComponent(id)}/versions`),
      )
    ).versions;
  },

  async pinVersion(id: string, version: number, pinned = true): Promise<void> {
    await fetch(
      `${API}/scenes/${encodeURIComponent(id)}/versions/${version}/pin`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ pinned }),
      },
    );
  },

  /** Copy an old version's content back onto the scene as a new, latest version. */
  async restoreVersion(id: string, version: number): Promise<void> {
    const old = await asJSON(
      await fetch(
        `${API}/scenes/${encodeURIComponent(id)}/versions/${version}`,
      ),
    );
    await fetch(`${API}/scenes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        elements: old.elements,
        appState: old.appState,
        files: old.files,
      }),
    });
  },

  async uploadThumbnail(id: string, png: Blob): Promise<void> {
    await fetch(`${API}/scenes/${encodeURIComponent(id)}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png,
    });
  },

  thumbnailUrl(id: string, cacheKey?: string | number): string {
    const suffix = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : "";
    return `${API}/scenes/${encodeURIComponent(id)}/thumbnail${suffix}`;
  },

  // --- region comments ---

  async listComments(sceneId: string): Promise<RemoteCommentThread[]> {
    return (
      await asJSON(
        await fetch(`${API}/scenes/${encodeURIComponent(sceneId)}/comments`),
      )
    ).comments;
  },

  async createComment(
    sceneId: string,
    region: { x: number; y: number; width: number; height: number },
    text: string,
  ): Promise<RemoteCommentThread> {
    return (
      await asJSON(
        await fetch(`${API}/scenes/${encodeURIComponent(sceneId)}/comments`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ ...region, text, author: "user" }),
        }),
      )
    ).comment;
  },

  async replyToComment(
    commentId: string,
    text: string,
  ): Promise<RemoteCommentThread> {
    return (
      await asJSON(
        await fetch(
          `${API}/comments/${encodeURIComponent(commentId)}/messages`,
          {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ text, author: "user" }),
          },
        ),
      )
    ).comment;
  },

  async resolveComment(commentId: string): Promise<void> {
    await fetch(`${API}/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    });
  },
};
