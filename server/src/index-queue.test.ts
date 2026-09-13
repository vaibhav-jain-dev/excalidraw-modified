import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exq-"));
process.env.EXCALIDRAW_LOCAL_DATA_DIR = tmp;

const queue = await import("./index-queue.ts");

describe("index queue", () => {
  beforeEach(() => queue.reset());
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs a queued job", async () => {
    const seen: string[] = [];
    queue.setIndexer((id) => {
      seen.push(id);
    });
    queue.enqueue("a");
    await queue.whenIdle();
    assert.deepEqual(seen, ["a"]);
  });

  it("coalesces repeat saves of the same scene into one job", async () => {
    const seen: string[] = [];
    queue.setIndexer((id) => {
      seen.push(id);
    });
    queue.enqueue("a");
    queue.enqueue("a");
    queue.enqueue("a");
    queue.enqueue("b");
    await queue.whenIdle();
    assert.deepEqual(seen.sort(), ["a", "b"]);
  });

  it("runs one at a time, in order", async () => {
    const events: string[] = [];
    queue.setIndexer(async (id) => {
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end:${id}`);
    });
    queue.enqueue("a");
    queue.enqueue("b");
    await queue.whenIdle();
    assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
  });

  it("keeps draining after a job throws", async () => {
    const seen: string[] = [];
    queue.setIndexer((id) => {
      seen.push(id);
      if (id === "bad") {
        throw new Error("boom");
      }
    });
    queue.enqueue("bad");
    queue.enqueue("good");
    await queue.whenIdle();
    assert.deepEqual(seen, ["bad", "good"]);
  });

  it("reports what is running and what is waiting", async () => {
    const releases: Array<() => void> = [];
    queue.setIndexer(
      () => new Promise<void>((r) => releases.push(r)),
    );
    queue.enqueue("a");
    queue.enqueue("b");
    await new Promise((r) => setTimeout(r, 10));

    const status = queue.status();
    assert.equal(status.running, "a");
    assert.deepEqual(status.pending, ["b"]);
    assert.equal(status.queued, 2);

    const idle = queue.whenIdle();
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 10));
    }
    await idle;
    assert.equal(queue.status().queued, 0);
  });

  it("persists pending work and picks it up after a restart", async () => {
    // a job that never settles, so "b" is still on disk as pending
    queue.setIndexer(() => new Promise<void>(() => {}));
    queue.enqueue("a");
    queue.enqueue("b");
    await new Promise((r) => setTimeout(r, 5));

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp, "index-queue.json"), "utf8"),
    );
    assert.deepEqual(onDisk.pending, ["b"]);

    // simulate a restart: fresh state, same file
    queue.reset();
    const seen: string[] = [];
    queue.setIndexer((id) => {
      seen.push(id);
    });
    assert.equal(queue.resumePending(), 1);
    await queue.whenIdle();
    assert.deepEqual(seen, ["b"]);
  });

  it("resolves immediately when nothing is queued", async () => {
    await queue.whenIdle();
  });
});
