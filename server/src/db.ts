import { DatabaseSync } from "node:sqlite";

import { ensureDataDirs, dbFile } from "./paths.ts";

/** Values `node:sqlite` accepts as bound statement parameters. */
type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * SQLite metadata store. Scene JSON and blobs live on disk (see `store/`); this
 * database only holds what we need to list, order, version and (later) search
 * scenes. Uses the built-in `node:sqlite` module — no native dependency.
 */

ensureDataDirs();

export const db: DatabaseSync = new DatabaseSync(dbFile());

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

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
