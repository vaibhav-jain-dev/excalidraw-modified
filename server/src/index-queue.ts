import fs from "node:fs";
import path from "node:path";

import { config } from "./config.ts";
import { ensureDir } from "./paths.ts";

/**
 * The indexing queue.
 *
 * A save writes one file, bumps a version and returns. Everything derived from
 * it — `scene.md`, the semantic JSON, the mermaid view, the FTS rows, the
 * embeddings — is queued here instead, so the editor never waits on an
 * embedding run or a disk full of derived files.
 *
 * Rules that matter:
 *  - **Coalesced per scene.** Save five times in ten seconds and the scene is
 *    indexed once, against its last state. A pending job is a scene id, never
 *    a snapshot.
 *  - **One at a time.** Node is single-threaded; running two indexers just
 *    interleaves their I/O and makes failures harder to reason about.
 *  - **Idempotent.** Every job recomputes from the scene on disk, so a crash
 *    mid-job costs a redo and never a corrupt index.
 *  - **Survives restart.** Pending ids are persisted; on boot they are picked
 *    back up.
 *
 * The tag/link graph is deliberately NOT here: it is in-memory and cheap, and
 * an agent that tags an element then asks for the tag must see it. Only the
 * expensive, eventually-consistent work is deferred.
 */

const queueFile = (): string => path.join(config.dataDir, "index-queue.json");

type Indexer = (sceneId: string) => void | Promise<void>;

let indexer: Indexer | null = null;
const order: string[] = [];
const pending = new Set<string>();
let running: string | null = null;
let draining = false;
let loaded = false;
let idleWaiters: Array<() => void> = [];

const persist = (): void => {
  try {
    ensureDir(config.dataDir);
    fs.writeFileSync(
      queueFile(),
      `${JSON.stringify({ pending: order }, null, 2)}\n`,
    );
  } catch {
    // the queue is a convenience, not a source of truth — a scene that misses
    // its job can always be re-indexed by saving it or rebuilding
  }
};

const settleIfIdle = (): void => {
  if (running === null && order.length === 0) {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
};

const drain = async (): Promise<void> => {
  if (draining) {
    return;
  }
  draining = true;
  try {
    while (order.length) {
      const sceneId = order.shift()!;
      pending.delete(sceneId);
      running = sceneId;
      persist();
      try {
        await indexer?.(sceneId);
      } catch (error) {
        console.warn(`indexing ${sceneId} failed`, error);
      }
      running = null;
    }
  } finally {
    draining = false;
    persist();
    settleIfIdle();
  }
};

/** Wire the work to run. Called once at startup by the scene store. */
export const setIndexer = (fn: Indexer): void => {
  indexer = fn;
};

/** Pick up anything left pending by a previous run. */
export const resumePending = (): number => {
  if (loaded) {
    return 0;
  }
  loaded = true;
  let restored = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(queueFile(), "utf8")) as {
      pending?: unknown;
    };
    if (Array.isArray(parsed.pending)) {
      for (const id of parsed.pending) {
        if (typeof id === "string" && !pending.has(id)) {
          pending.add(id);
          order.push(id);
          restored += 1;
        }
      }
    }
  } catch {
    // no queue file, or an unreadable one
  }
  if (restored) {
    void drain();
  }
  return restored;
};

export const enqueue = (sceneId: string): void => {
  if (pending.has(sceneId)) {
    // already queued — the job re-reads the scene, so the newer save is
    // covered without adding a second pass
    return;
  }
  pending.add(sceneId);
  order.push(sceneId);
  persist();
  // yield first so the save's response goes out before indexing starts
  setTimeout(() => void drain(), 0).unref?.();
};

export interface IndexStatus {
  running: string | null;
  pending: string[];
  queued: number;
}

export const status = (): IndexStatus => ({
  running,
  pending: [...order],
  queued: order.length + (running ? 1 : 0),
});

/** Resolves when the queue is empty and nothing is running. For tests. */
export const whenIdle = (): Promise<void> => {
  if (running === null && order.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
  });
};

/**
 * Test helper: forget everything without running it. Clears `draining` too —
 * a drain awaiting a job that will never settle would otherwise block every
 * later drain, since only one may run at a time.
 */
export const reset = (): void => {
  order.length = 0;
  pending.clear();
  running = null;
  draining = false;
  loaded = false;
  idleWaiters = [];
};
