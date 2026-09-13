import { DatabaseSync } from "node:sqlite";

import { load as loadSqliteVec } from "sqlite-vec";

import { ensureDataDirs, dbFile } from "./paths.ts";

/** Values `node:sqlite` accepts as bound statement parameters. */
type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * SQLite metadata store. Scene JSON and blobs live on disk (see `store/`); this
 * database only holds what we need to list, order, version and search scenes.
 * Uses the built-in `node:sqlite` module (FTS5 is compiled in) plus the
 * `sqlite-vec` extension for embeddings — no other native dependency.
 */

ensureDataDirs();

export const db: DatabaseSync = new DatabaseSync(dbFile(), {
  allowExtension: true,
});

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

/** Whether the sqlite-vec extension loaded — false disables vector search. */
export let vectorSearchAvailable = false;
try {
  loadSqliteVec(db);
  vectorSearchAvailable = true;
} catch (error) {
  console.warn(
    "sqlite-vec extension failed to load — vector search disabled:",
    error,
  );
}

/** Ordered migrations. Append only — never edit an applied migration. */
const MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [
    1,
    `
    CREATE TABLE scenes (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      tags           TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      latest_version INTEGER NOT NULL DEFAULT 0,
      element_count  INTEGER NOT NULL DEFAULT 0,
      pinned         INTEGER NOT NULL DEFAULT 0,
      deleted_at     TEXT
    );

    CREATE INDEX idx_scenes_updated ON scenes (updated_at DESC);

    CREATE TABLE scene_versions (
      scene_id      TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
      version       INTEGER NOT NULL,
      created_at    TEXT NOT NULL,
      element_count INTEGER NOT NULL DEFAULT 0,
      pinned        INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL DEFAULT 'editor',
      PRIMARY KEY (scene_id, version)
    );

    CREATE INDEX idx_scene_versions_scene
      ON scene_versions (scene_id, version DESC);
  `,
  ],
  [
    2,
    `
    ALTER TABLE scenes ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE scenes ADD COLUMN category TEXT NOT NULL DEFAULT '';
    ALTER TABLE scenes ADD COLUMN thumbnail_updated_at TEXT;
    CREATE INDEX idx_scenes_category ON scenes (category);
  `,
  ],
  [
    3,
    `
    ALTER TABLE scenes ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE scenes ADD COLUMN expires_at TEXT;
    CREATE INDEX idx_scenes_expires ON scenes (expires_at)
      WHERE expires_at IS NOT NULL;
  `,
  ],
  [
    4,
    `
    CREATE VIRTUAL TABLE scenes_fts USING fts5(
      scene_id UNINDEXED,
      name,
      description,
      category,
      tags,
      body
    );
  `,
  ],
  [
    5,
    `
    CREATE TABLE kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  ],
  [
    6,
    `
    -- Region comments: a marked rectangle on a scene with a message thread.
    -- Resolving a comment deletes it (and its messages) entirely — there is
    -- no archive; once addressed, the data is no longer needed.
    CREATE TABLE comments (
      id         TEXT PRIMARY KEY,
      scene_id   TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
      x          REAL NOT NULL,
      y          REAL NOT NULL,
      width      REAL NOT NULL,
      height     REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_comments_scene ON comments (scene_id);

    CREATE TABLE comment_messages (
      id         TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
      author     TEXT NOT NULL DEFAULT 'user',
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_comment_messages_comment
      ON comment_messages (comment_id, created_at);
  `,
  ],
  [
    7,
    `
    -- where the drawing sits for a human: a slash-separated path, independent
    -- of category. Displayed on every card and indexed; the graph turns it
    -- into a chain of folder nodes.
    ALTER TABLE scenes ADD COLUMN folder TEXT NOT NULL DEFAULT '';
    CREATE INDEX idx_scenes_folder ON scenes (folder);
  `,
  ],
];

const migrate = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as unknown as Array<{ version: number }>
    ).map((row) => row.version),
  );

  for (const [version, sql] of MIGRATIONS) {
    if (applied.has(version)) {
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

migrate();

/**
 * Typed wrappers around `node:sqlite`, whose `all`/`get` return
 * `Record<string, SQLOutputValue>`. Callers own the shape they ask for.
 */
export const queryRows = <T>(sql: string, ...params: SqlParam[]): T[] =>
  db.prepare(sql).all(...params) as unknown as T[];

export const queryRow = <T>(
  sql: string,
  ...params: SqlParam[]
): T | undefined =>
  db.prepare(sql).get(...params) as unknown as T | undefined;

/** Small durable key/value store — used to remember the vector dimension, etc. */
export const kvGet = (key: string): string | undefined =>
  queryRow<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
    ?.value;

export const kvSet = (key: string, value: string): void => {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
};
