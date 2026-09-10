import fs from "node:fs";
import path from "node:path";

import { config } from "./config.ts";

/** Filesystem layout under `config.dataDir`. Kept in one place so the on-disk
 * shape is easy to see and change. See `LOCAL_FIRST_PLAN.md` § "On-disk layout". */

export const dbFile = (): string => path.join(config.dataDir, "index.db");

export const scenesDir = (): string => path.join(config.dataDir, "scenes");

export const sceneDir = (id: string): string => path.join(scenesDir(), id);

export const versionFile = (id: string, version: number): string =>
  path.join(sceneDir(id), `v${String(version).padStart(4, "0")}.excalidraw`);

export const latestFile = (id: string): string =>
  path.join(sceneDir(id), "latest.excalidraw");

export const thumbsDir = (): string => path.join(config.dataDir, "thumbs");

export const thumbFile = (id: string): string =>
  path.join(thumbsDir(), `${id}.png`);

export const filesDir = (): string => path.join(config.dataDir, "files");

export const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

/** Create the base directory tree. Called once on startup. */
export const ensureDataDirs = (): void => {
  for (const dir of [config.dataDir, scenesDir(), thumbsDir(), filesDir()]) {
    ensureDir(dir);
  }
};
