/**
 * Embedding storage/search via the `sqlite-vec` extension (loaded in `db.ts`).
 * `vec0` tables need an integer rowid; we reuse `scenes`' own implicit SQLite
 * rowid (stable for the life of the row) instead of a separate mapping table.
 */

import { config } from "../config.ts";
import { db, kvGet, kvSet, queryRow, queryRows, vectorSearchAvailable } from "../db.ts";

const TABLE = "scene_vectors";

let tableReady: boolean | null = null;

/** Lazily create the vec0 table for the configured embedding dimension. */
const ensureTable = (): boolean => {
  if (tableReady !== null) {
    return tableReady;
  }
  if (!vectorSearchAvailable) {
    tableReady = false;
    return false;
  }
  const recordedDim = kvGet("vector_dim");
  if (recordedDim && Number(recordedDim) !== config.embedDim) {
    console.warn(
      `scene_vectors was built for dimension ${recordedDim}, but the ` +
        `configured embed model produces ${config.embedDim} — vector search ` +
        "is disabled until they match (change EXCALIDRAW_LOCAL_EMBED_DIM back, " +
        "or delete index.db to rebuild).",
    );
    tableReady = false;
    return false;
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(embedding float[${config.embedDim}])`,
  );
  kvSet("vector_dim", String(config.embedDim));
  tableReady = true;
  return true;
};

const toBuffer = (vector: number[]): Buffer =>
  Buffer.from(new Float32Array(vector).buffer);

const sceneRowid = (sceneId: string): bigint | undefined =>
  queryRow<{ rowid: number | bigint }>(
    "SELECT rowid FROM scenes WHERE id = ?",
    sceneId,
  )?.rowid as bigint | undefined;

export const isVectorSearchReady = (): boolean => ensureTable();

export const upsertSceneVector = (sceneId: string, vector: number[]): void => {
  if (!ensureTable() || vector.length !== config.embedDim) {
    return;
  }
  const rowid = sceneRowid(sceneId);
  if (rowid === undefined) {
    return;
  }
  db.prepare(`DELETE FROM ${TABLE} WHERE rowid = ?`).run(rowid);
  db.prepare(`INSERT INTO ${TABLE} (rowid, embedding) VALUES (?, ?)`).run(
    rowid,
    toBuffer(vector),
  );
};

export const removeSceneVector = (sceneId: string): void => {
  if (!ensureTable()) {
    return;
  }
  const rowid = sceneRowid(sceneId);
  if (rowid !== undefined) {
    db.prepare(`DELETE FROM ${TABLE} WHERE rowid = ?`).run(rowid);
  }
};

export interface VectorHit {
  sceneId: string;
  distance: number;
}

/** Nearest scenes to `vector` by cosine-ish L2 distance (smaller = closer). */
export const searchSceneVectors = (
  vector: number[],
  limit = 20,
): VectorHit[] => {
  if (!ensureTable() || vector.length !== config.embedDim) {
    return [];
  }
  const rows = queryRows<{ rowid: number | bigint; distance: number }>(
    `SELECT rowid, distance FROM ${TABLE} WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    toBuffer(vector),
    limit,
  );
  return rows
    .map((row) => {
      const scene = queryRow<{ id: string }>(
        "SELECT id FROM scenes WHERE rowid = ? AND deleted_at IS NULL",
        row.rowid as bigint,
      );
      return scene ? { sceneId: scene.id, distance: row.distance } : null;
    })
    .filter((hit): hit is VectorHit => hit !== null);
};
