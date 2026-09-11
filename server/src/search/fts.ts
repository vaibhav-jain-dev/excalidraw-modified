/**
 * Full-text search over scene metadata + their derived markdown, via SQLite's
 * built-in FTS5 (no native dependency — `node:sqlite` ships it compiled in).
 */

import { db, queryRows } from "../db.ts";

export interface FtsHit {
  sceneId: string;
  snippet: string;
  score: number;
}

export const reindexFts = (
  sceneId: string,
  fields: {
    name: string;
    description: string;
    category: string;
    tags: string[];
    body: string;
  } | null,
): void => {
  db.prepare("DELETE FROM scenes_fts WHERE scene_id = ?").run(sceneId);
  if (!fields) {
    return; // scene deleted — leave it out of the index
  }
  db.prepare(
    `INSERT INTO scenes_fts (scene_id, name, description, category, tags, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sceneId,
    fields.name,
    fields.description,
    fields.category,
    fields.tags.join(" "),
    fields.body,
  );
};

/** Build a permissive FTS5 MATCH expression: prefix-OR across the query's words. */
const toFtsQuery = (query: string): string | null => {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`);
  return terms.length ? terms.join(" OR ") : null;
};

export const searchFts = (query: string, limit = 20): FtsHit[] => {
  const match = toFtsQuery(query);
  if (!match) {
    return [];
  }
  try {
    return queryRows<{ scene_id: string; snippet: string; score: number }>(
      `SELECT scene_id,
              snippet(scenes_fts, 4, '[', ']', '…', 12) AS snippet,
              bm25(scenes_fts) AS score
       FROM scenes_fts
       WHERE scenes_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
      match,
      limit,
    ).map((row) => ({
      sceneId: row.scene_id,
      snippet: row.snippet,
      score: row.score,
    }));
  } catch {
    // a pathological query (unbalanced quotes etc.) — treat as no matches
    return [];
  }
};
