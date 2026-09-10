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
}

export interface RemoteSceneMeta {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  pinned?: boolean;
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
      headers: jsonHeaders,
      body: serializeAsJSON(elements, appState, files, "local"),
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
};
