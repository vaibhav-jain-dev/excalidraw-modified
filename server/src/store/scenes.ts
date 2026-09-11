import fs from "node:fs";

import { config } from "../config.ts";
import { db, queryRow, queryRows } from "../db.ts";
import {
  fromSemantic,
  mergeSemantic,
  toMarkdown,
  toSemantic,
  type SemanticScene,
} from "../derive/semantic.ts";
import { isGraphShaped, toMermaid } from "../derive/mermaid.ts";
import { broadcastSceneChanged } from "../events.ts";
import { newId } from "../id.ts";
import {
  ensureDir,
  latestFile,
  markdownFile,
  mermaidFile,
  sceneDir,
  semanticFile,
  thumbFile,
  versionFile,
} from "../paths.ts";
import { embedText } from "../search/embeddings.ts";
import { reindexFts } from "../search/fts.ts";
import { removeSceneVector, upsertSceneVector } from "../search/vector.ts";

/**
 * Scene CRUD + version history. The SQLite row is the index; the authoritative
 * scene lives on disk as `scenes/<id>/vNNNN.excalidraw` (a standard, lossless
 * Excalidraw file) with `latest.excalidraw` mirroring the newest version.
 */

export type SceneSource = "editor" | "mcp" | "import" | "api";

const EXCALIDRAW_FILE_TYPE = "excalidraw";
const EXCALIDRAW_FILE_VERSION = 2;

export class SceneNotFoundError extends Error {
  constructor(id: string) {
    super(`scene not found: ${id}`);
    this.name = "SceneNotFoundError";
  }
}

export interface SceneSummary {
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
  /** a scratch scene — auto-deleted when idle 15 min or after 1 hour */
  temporary: boolean;
  expiresAt: string | null;
}

/** ms a temporary scene lives without activity, and its hard cap. */
export const TEMP_IDLE_MS = 15 * 60 * 1000;
export const TEMP_MAX_MS = 60 * 60 * 1000;

export interface SceneContent {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface SceneVersionInfo {
  version: number;
  createdAt: string;
  elementCount: number;
  pinned: boolean;
  source: string;
}

interface SceneRow {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string;
  created_at: string;
  updated_at: string;
  latest_version: number;
  element_count: number;
  pinned: number;
  thumbnail_updated_at: string | null;
  temporary: number;
  expires_at: string | null;
}

const EMPTY_CONTENT = (): SceneContent => ({
  elements: [],
  appState: {},
  files: {},
});

const rowToSummary = (row: SceneRow): SceneSummary => ({
  id: row.id,
  name: row.name,
  description: row.description ?? "",
  category: row.category ?? "",
  tags: parseTags(row.tags),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  latestVersion: row.latest_version,
  elementCount: row.element_count,
  pinned: row.pinned !== 0,
  hasThumbnail: row.thumbnail_updated_at != null,
  temporary: row.temporary !== 0,
  expiresAt: row.expires_at,
});

const parseTags = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
};

const countLiveElements = (elements: unknown[]): number =>
  elements.filter(
    (element) =>
      !(
        element &&
        typeof element === "object" &&
        (element as { isDeleted?: unknown }).isDeleted === true
      ),
  ).length;

export const listScenes = (): SceneSummary[] =>
  queryRows<SceneRow>(
    `SELECT * FROM scenes
     WHERE deleted_at IS NULL
     ORDER BY pinned DESC, updated_at DESC`,
  ).map(rowToSummary);

export const getSceneSummary = (id: string): SceneSummary | null => {
  const row = queryRow<SceneRow>(
    "SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL",
    id,
  );
  return row ? rowToSummary(row) : null;
};

export const createScene = (
  opts: {
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    temporary?: boolean;
  } = {},
): SceneSummary => {
  const id = newId();
  const now = new Date().toISOString();
  const name = opts.name?.trim() || "Untitled";
  const tags = JSON.stringify(opts.tags ?? []);
  const expiresAt = opts.temporary
    ? new Date(Date.now() + TEMP_IDLE_MS).toISOString()
    : null;

  db.prepare(
    `INSERT INTO scenes
       (id, name, description, category, tags, created_at, updated_at,
        temporary, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    opts.description?.trim() ?? "",
    opts.category?.trim() ?? "",
    tags,
    now,
    now,
    opts.temporary ? 1 : 0,
    expiresAt,
  );
  ensureDir(sceneDir(id));

  const summary = getSceneSummary(id);
  if (!summary) {
    throw new Error(`failed to create scene ${id}`);
  }
  reindexMetaOnly(summary);
  return summary;
};

/**
 * Index a scene's title/description/category/tags even before it has any
 * content (a fresh scene, or a meta-only edit) — `regenerateDerived` (which
 * also indexes the drawing's body) only runs on save.
 */
const reindexMetaOnly = (summary: SceneSummary): void => {
  const existingBody = fs.existsSync(markdownFile(summary.id))
    ? fs.readFileSync(markdownFile(summary.id), "utf8")
    : "";
  reindexFts(summary.id, {
    name: summary.name,
    description: summary.description,
    category: summary.category,
    tags: summary.tags,
    body: existingBody,
  });
};

export const updateSceneMeta = (
  id: string,
  patch: {
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    pinned?: boolean;
  },
): SceneSummary => {
  const summary = getSceneSummary(id);
  if (!summary) {
    throw new SceneNotFoundError(id);
  }

  const name = patch.name?.trim() || summary.name;
  const description = patch.description?.trim() ?? summary.description;
  const category = patch.category?.trim() ?? summary.category;
  const tags = JSON.stringify(patch.tags ?? summary.tags);
  const pinned = (patch.pinned ?? summary.pinned) ? 1 : 0;

  db.prepare(
    `UPDATE scenes
     SET name = ?, description = ?, category = ?, tags = ?, pinned = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    description,
    category,
    tags,
    pinned,
    new Date().toISOString(),
    id,
  );

  const updated = getSceneSummary(id) as SceneSummary;
  reindexMetaOnly(updated);
  return updated;
};

/** Record that a fresh thumbnail was written for the scene. */
export const markThumbnailUpdated = (id: string): void => {
  db.prepare(
    "UPDATE scenes SET thumbnail_updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
};

export const listCategories = (): string[] =>
  queryRows<{ category: string }>(
    `SELECT DISTINCT category FROM scenes
     WHERE deleted_at IS NULL AND category <> ''
     ORDER BY category`,
  ).map((row) => row.category);

export const softDeleteScene = (id: string): boolean => {
  const result = db
    .prepare(
      "UPDATE scenes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .run(new Date().toISOString(), id);
  const deleted = Number(result.changes) > 0;
  if (deleted) {
    reindexFts(id, null);
    removeSceneVector(id);
  }
  return deleted;
};

/** Remove a scene's rows and files entirely (used for expired temp scenes). */
export const hardDeleteScene = (id: string): void => {
  // remove the vector row first — it's keyed off `scenes.rowid`, which the
  // scene delete below invalidates
  removeSceneVector(id);
  reindexFts(id, null);
  db.prepare("DELETE FROM scene_versions WHERE scene_id = ?").run(id);
  db.prepare("DELETE FROM scenes WHERE id = ?").run(id);
  try {
    fs.rmSync(sceneDir(id), { recursive: true, force: true });
    fs.rmSync(thumbFile(id), { force: true });
  } catch {
    // best-effort
  }
};

/** Push a temporary scene's expiry out to now + idle window (capped at 1h). */
export const refreshTempExpiry = (id: string): void => {
  const summary = getSceneSummary(id);
  if (!summary?.temporary) {
    return;
  }
  const created = Date.parse(summary.createdAt);
  const next = Math.min(
    Date.now() + TEMP_IDLE_MS,
    created + TEMP_MAX_MS,
  );
  db.prepare("UPDATE scenes SET expires_at = ? WHERE id = ?").run(
    new Date(next).toISOString(),
    id,
  );
};

/** Hard-delete every temporary scene whose expiry has passed. Returns the count. */
export const sweepExpiredScenes = (): number => {
  const now = new Date().toISOString();
  const expired = queryRows<{ id: string }>(
    `SELECT id FROM scenes
     WHERE temporary = 1 AND expires_at IS NOT NULL AND expires_at < ?`,
    now,
  );
  for (const { id } of expired) {
    hardDeleteScene(id);
  }
  return expired.length;
};

export const getSceneContent = (
  id: string,
  version?: number,
): SceneContent | null => {
  const summary = getSceneSummary(id);
  if (!summary) {
    return null;
  }
  if (summary.latestVersion === 0) {
    return EMPTY_CONTENT();
  }

  const file =
    version === undefined ? latestFile(id) : versionFile(id, version);
  if (!fs.existsSync(file)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<{
    elements: unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  }>;

  return {
    elements: Array.isArray(parsed.elements) ? parsed.elements : [],
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
  };
};

export const listVersions = (id: string): SceneVersionInfo[] => {
  if (!getSceneSummary(id)) {
    throw new SceneNotFoundError(id);
  }
  return queryRows<{
    version: number;
    created_at: string;
    element_count: number;
    pinned: number;
    source: string;
  }>(
    `SELECT version, created_at, element_count, pinned, source
     FROM scene_versions WHERE scene_id = ? ORDER BY version DESC`,
    id,
  ).map((row) => ({
    version: row.version,
    createdAt: row.created_at,
    elementCount: row.element_count,
    pinned: row.pinned !== 0,
    source: row.source,
  }));
};

export const saveScene = (
  id: string,
  content: Partial<SceneContent>,
  source: SceneSource = "editor",
  originClientId?: string,
): { version: number; summary: SceneSummary } => {
  const summary = getSceneSummary(id);
  if (!summary) {
    throw new SceneNotFoundError(id);
  }

  const elements = Array.isArray(content.elements) ? content.elements : [];
  const version = summary.latestVersion + 1;
  const now = new Date().toISOString();
  const elementCount = countLiveElements(elements);

  const payload = `${JSON.stringify(
    {
      type: EXCALIDRAW_FILE_TYPE,
      version: EXCALIDRAW_FILE_VERSION,
      source: `excalidraw-local:${source}`,
      elements,
      appState: content.appState ?? {},
      files: content.files ?? {},
    },
    null,
    2,
  )}\n`;

  ensureDir(sceneDir(id));
  fs.writeFileSync(versionFile(id, version), payload);
  fs.writeFileSync(latestFile(id), payload);

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO scene_versions
         (scene_id, version, created_at, element_count, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, version, now, elementCount, source);
    db.prepare(
      `UPDATE scenes
       SET latest_version = ?, element_count = ?, updated_at = ?
       WHERE id = ?`,
    ).run(version, elementCount, now, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  pruneVersions(id);
  regenerateDerived(id, elements);
  refreshTempExpiry(id);
  broadcastSceneChanged({
    type: "scene-changed",
    id,
    version,
    source,
    originClientId,
  });

  return { version, summary: getSceneSummary(id) as SceneSummary };
};

/**
 * Regenerate the bot-friendly views (`scene.semantic.json`, `scene.md`,
 * `scene.mmd`) plus the search indexes. The heavy embedding call happens
 * off to the side — a save is never slowed down by, or fails because of,
 * Ollama being unavailable.
 */
const regenerateDerived = (id: string, elements: unknown[]): void => {
  try {
    const semantic = toSemantic(elements as Array<Record<string, unknown>>);
    const summary = getSceneSummary(id);
    const name = summary?.name ?? "Untitled";

    fs.writeFileSync(
      semanticFile(id),
      `${JSON.stringify(semantic, null, 2)}\n`,
    );
    const markdown = toMarkdown(semantic, name);
    fs.writeFileSync(markdownFile(id), markdown);

    if (isGraphShaped(semantic)) {
      fs.writeFileSync(mermaidFile(id), toMermaid(semantic));
    } else {
      fs.rmSync(mermaidFile(id), { force: true });
    }

    reindexFts(id, {
      name,
      description: summary?.description ?? "",
      category: summary?.category ?? "",
      tags: summary?.tags ?? [],
      body: markdown,
    });

    // fire-and-forget: never let embedding latency or failure touch the save
    void embedText(markdown).then((vector) => {
      if (vector) {
        upsertSceneVector(id, vector);
      }
    });
  } catch (error) {
    // derived views are best-effort — a bad scene must not fail the save
    console.warn(`failed to regenerate derived views for ${id}`, error);
  }
};

// ---------------------------------------------------------------------------
// semantic (bot-friendly) access
// ---------------------------------------------------------------------------

export const getSemantic = (id: string): SemanticScene | null => {
  const content = getSceneContent(id);
  if (!content) {
    return null;
  }
  return toSemantic(content.elements as Array<Record<string, unknown>>);
};

export const getMarkdown = (id: string): string | null => {
  const semantic = getSemantic(id);
  if (!semantic) {
    return null;
  }
  return toMarkdown(semantic, getSceneSummary(id)?.name ?? "Untitled");
};

/** Mermaid flowchart for a graph-shaped scene, or `null` if it isn't one. */
export const getMermaid = (id: string): string | null => {
  const semantic = getSemantic(id);
  if (!semantic || !isGraphShaped(semantic)) {
    return null;
  }
  return toMermaid(semantic);
};

// ---------------------------------------------------------------------------
// named anchors — `customData.anchor` on a single element, for stable
// deep-links and crop-to-element renders
// ---------------------------------------------------------------------------

export interface AnchorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tag (or untag) one element in a scene with a stable name. */
export const setElementAnchor = (
  sceneId: string,
  elementId: string,
  anchor: string | null,
): boolean => {
  const content = getSceneContent(sceneId);
  if (!content) {
    throw new SceneNotFoundError(sceneId);
  }
  let found = false;
  const elements = (content.elements as Array<Record<string, any>>).map(
    (element) => {
      if (element.id !== elementId) {
        return element;
      }
      found = true;
      const customData = { ...(element.customData ?? {}) };
      if (anchor) {
        customData.anchor = anchor;
      } else {
        delete customData.anchor;
      }
      return { ...element, customData };
    },
  );
  if (!found) {
    return false;
  }
  saveScene(
    sceneId,
    { elements, appState: content.appState, files: content.files },
    "api",
  );
  return true;
};

/** Absolute bounding box of the element tagged with `anchor`, if any. */
export const findAnchorBounds = (
  sceneId: string,
  anchor: string,
): AnchorBounds | null => {
  const content = getSceneContent(sceneId);
  if (!content) {
    return null;
  }
  const element = (content.elements as Array<Record<string, any>>).find(
    (el) => el && !el.isDeleted && el.customData?.anchor === anchor,
  );
  if (!element) {
    return null;
  }
  return {
    x: element.x ?? 0,
    y: element.y ?? 0,
    width: element.width ?? 0,
    height: element.height ?? 0,
  };
};

/** Every anchor name currently tagged in a scene, with the element it names. */
export const listAnchors = (
  sceneId: string,
): Array<{ anchor: string; elementId: string }> => {
  const content = getSceneContent(sceneId);
  if (!content) {
    return [];
  }
  return (content.elements as Array<Record<string, any>>)
    .filter((el) => el && !el.isDeleted && typeof el.customData?.anchor === "string")
    .map((el) => ({ anchor: el.customData.anchor as string, elementId: el.id }));
};

/** Replace a scene's whole content from a semantic graph. */
export const saveSceneFromSemantic = (
  id: string,
  graph: Partial<SemanticScene>,
  source: SceneSource = "mcp",
): { version: number; summary: SceneSummary } =>
  saveScene(id, { elements: fromSemantic(graph), appState: {}, files: {} }, source);

/** Merge a semantic fragment into a scene, keeping what's already there. */
export const appendSemantic = (
  id: string,
  fragment: Partial<SemanticScene>,
  source: SceneSource = "mcp",
): { version: number; summary: SceneSummary } => {
  const content = getSceneContent(id);
  if (!content) {
    throw new SceneNotFoundError(id);
  }
  return saveScene(
    id,
    {
      elements: mergeSemantic(
        content.elements as Array<Record<string, unknown>>,
        fragment,
      ),
      appState: {},
      files: {},
    },
    source,
  );
};

export const setVersionPinned = (
  id: string,
  version: number,
  pinned: boolean,
): void => {
  const result = db
    .prepare(
      "UPDATE scene_versions SET pinned = ? WHERE scene_id = ? AND version = ?",
    )
    .run(pinned ? 1 : 0, id, version);
  if (Number(result.changes) === 0) {
    throw new SceneNotFoundError(`${id}@${version}`);
  }
};

/** Drop the oldest non-pinned versions (rows + files) beyond the keep limit. */
const pruneVersions = (id: string): void => {
  const keep = config.maxVersionsPerScene;
  const stale = queryRows<{ version: number }>(
    `SELECT version FROM scene_versions
     WHERE scene_id = ? AND pinned = 0
     ORDER BY version DESC`,
    id,
  ).slice(keep);

  for (const { version } of stale) {
    db.prepare(
      "DELETE FROM scene_versions WHERE scene_id = ? AND version = ?",
    ).run(id, version);
    try {
      fs.rmSync(versionFile(id, version));
    } catch {
      // already gone — nothing to do
    }
  }
};
