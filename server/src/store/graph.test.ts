import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// the graph writes into `config.dataDir`, which is read at import time — so
// point it at a scratch dir before the module is loaded
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exgraph-"));
process.env.EXCALIDRAW_LOCAL_DATA_DIR = tmp;

const graph = await import("./graph.ts");

const el = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  isDeleted: false,
  ...extra,
});

const scene = (
  elements: Array<Record<string, unknown>>,
  tags: string[] = [],
  extra: { category?: string; folder?: string } = {},
) =>
  graph.reconcileScene(
    { id: "s1", name: "Ingest pipeline", tags, ...extra },
    elements,
  );

describe("tag / link graph", () => {
  before(() => graph.reset());
  beforeEach(() => graph.reset());
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("normalizes tags so casing and spacing collapse to one node", () => {
    assert.equal(graph.normalizeTag("  Broken Code "), "broken-code");
    assert.equal(graph.normalizeTag("#MCP"), "mcp");
    assert.equal(graph.tagNode("Broken Code"), "tag:broken-code");
  });

  it("derives scene-level and box-level tags from the scene itself", () => {
    scene(
      [
        el("b1", { customData: { tags: ["broken-code", "Error Path"] }, text: "Retry" }),
        el("b2"),
      ],
      ["local-first"],
    );

    const tags = graph.listTags();
    assert.deepEqual(
      tags.map((t) => t.tag).sort(),
      ["broken-code", "error-path", "local-first"],
    );
    assert.deepEqual(
      tags.find((t) => t.tag === "local-first"),
      { tag: "local-first", scenes: 1, boxes: 0 },
    );
    assert.deepEqual(
      tags.find((t) => t.tag === "broken-code"),
      { tag: "broken-code", scenes: 0, boxes: 1 },
    );
  });

  it("points a box tag at the element, not the file", () => {
    scene([el("b1", { customData: { tags: ["broken-code"] }, text: "Retry" })]);
    const detail = graph.getTag("broken-code");
    assert.equal(detail.scenes.length, 0);
    assert.deepEqual(detail.boxes, [
      { sceneId: "s1", elementId: "b1", label: "Retry" },
    ]);
  });

  it("takes a box label from its bound text element", () => {
    scene([
      el("b1", { customData: { tags: ["x"] } }),
      { id: "t1", type: "text", containerId: "b1", text: "Broken code path" },
    ]);
    assert.equal(graph.getTag("x").boxes[0]!.label, "Broken code path");
  });

  it("records drawing-to-drawing links with their render mode", () => {
    scene([
      el("l1", { customData: { link: { sceneId: "s2", name: "Graph store", render: "title" } } }),
    ]);
    assert.deepEqual(graph.linksFrom("s1"), [
      { sceneId: "s2", name: "Graph store", render: "title" },
    ]);
    assert.deepEqual(graph.linksTo("s2"), [{ sceneId: "s1", name: "Ingest pipeline" }]);
  });

  it("defaults an unknown render mode to an embed", () => {
    scene([el("l1", { customData: { link: { sceneId: "s2" } } })]);
    assert.equal(graph.linksFrom("s1")[0]!.render, "embed");
  });

  it("rewrites a scene's edges on every reconcile, so it cannot drift", () => {
    scene([el("b1", { customData: { tags: ["gone"] } })]);
    assert.equal(graph.listTags().length, 1);

    // the tag is removed in the editor and the scene saved again
    scene([el("b1")]);
    assert.deepEqual(graph.listTags(), []);
    // the orphaned tag node is collected too — tags exist only while used
    assert.equal(graph.snapshot().nodes["tag:gone"], undefined);
  });

  it("ignores deleted elements", () => {
    scene([el("b1", { isDeleted: true, customData: { tags: ["ghost"] } })]);
    assert.deepEqual(graph.listTags(), []);
  });

  it("walks outward from a tag to the boxes and scenes carrying it", () => {
    scene([el("b1", { customData: { tags: ["shared"] }, text: "Box" })], ["shared"]);

    const found = graph.neighbours("tag:shared", 1);
    assert.deepEqual(
      found.map((n) => n.kind).sort(),
      ["box", "scene"],
    );
    assert.ok(found.every((n) => n.hops === 1));
  });

  it("reaches a sibling scene at two hops through a shared tag", () => {
    graph.reconcileScene({ id: "s1", name: "One", tags: ["shared"] }, []);
    graph.reconcileScene({ id: "s2", name: "Two", tags: ["shared"] }, []);

    const one = graph.neighbours("scene:s1", 1).map((n) => n.id);
    assert.deepEqual(one, ["tag:shared"]);

    const two = graph.neighbours("scene:s1", 2);
    assert.ok(two.some((n) => n.id === "scene:s2" && n.hops === 2));
  });

  it("descends from a scene into its own tagged boxes and out to their tags", () => {
    scene([el("b1", { customData: { tags: ["deep"] }, text: "Box" })]);

    const one = graph.neighbours("scene:s1", 1);
    assert.deepEqual(one.map((n) => n.id), ["box:s1/b1"]);
    assert.equal(one[0]!.via, "contains");

    const two = graph.neighbours("scene:s1", 2);
    assert.ok(two.some((n) => n.id === "tag:deep" && n.hops === 2));
  });

  it("returns nothing for an unknown start node", () => {
    assert.deepEqual(graph.neighbours("tag:nope"), []);
  });

  it("nests a slash-separated category into a chain of nodes", () => {
    scene([], [], { category: "Architecture/Storage/Graph store" });

    const snap = graph.snapshot();
    assert.equal(snap.nodes["category:architecture"]?.label, "Architecture");
    assert.equal(snap.nodes["category:architecture/storage"]?.path, "Architecture/Storage");

    const childOf = snap.edges.filter((e) => e.kind === "child-of");
    assert.equal(childOf.length, 2);
    // the scene is filed under the LEAF, not the root
    const filed = snap.edges.find((e) => e.kind === "filed-under");
    assert.equal(filed?.to, "category:architecture/storage/graph store");
  });

  it("does the same for folders, independently of category", () => {
    scene([], [], { category: "Notes", folder: "work/local-first/spikes" });
    const snap = graph.snapshot();
    assert.equal(snap.nodes["folder:work/local-first"]?.label, "local-first");
    assert.equal(
      snap.edges.find((e) => e.kind === "lives-in")?.to,
      "folder:work/local-first/spikes",
    );
    // category and folder are separate axes and do not touch
    assert.equal(snap.nodes["folder:notes"], undefined);
  });

  it("walks from a scene out to its category and folder", () => {
    scene([], [], { category: "Product", folder: "work" });
    const ids = graph.neighbours("scene:s1", 1).map((n) => n.id).sort();
    assert.deepEqual(ids, ["category:product", "folder:work"]);
  });

  it("keeps what an LLM added after looking at the image", () => {
    scene([], ["drawn-by-hand"]);
    graph.annotate("s1", {
      tags: ["state machine", "Retry Logic"],
      note: "A retry ladder: failure feeds a backoff then a dead-letter box.",
    });

    const before = graph.describeScene("s1");
    assert.deepEqual(
      before!.tags.map((t) => `${t.tag}:${t.by}`).sort(),
      ["drawn-by-hand:scene", "retry-logic:agent", "state-machine:agent"],
    );
    assert.match(before!.note!, /retry ladder/);

    // a normal save re-derives the scene — the agent's work must not vanish
    scene([], ["drawn-by-hand"]);
    const after = graph.describeScene("s1");
    assert.deepEqual(
      after!.tags.map((t) => t.tag).sort(),
      ["drawn-by-hand", "retry-logic", "state-machine"],
    );
    assert.equal(after!.note, before!.note);
  });

  it("survives a full rebuild too", () => {
    scene([], ["kept"]);
    graph.annotate("s1", { tags: ["seen-by-model"], note: "a flow chart" });

    graph.resetDerived();
    assert.deepEqual(
      graph.listTags().map((t) => t.tag),
      ["seen-by-model"],
    );
    assert.equal(graph.describeScene("s1")?.note, "a flow chart");

    // re-deriving brings the scene's own tags back alongside
    scene([], ["kept"]);
    assert.deepEqual(
      graph.listTags().map((t) => t.tag).sort(),
      ["kept", "seen-by-model"],
    );
  });

  it("drops an agent's annotations on request without touching derived ones", () => {
    scene([], ["mine"]);
    graph.annotate("s1", { tags: ["guessed"], note: "n" });
    assert.equal(graph.clearAnnotations("s1"), 1);

    const facts = graph.describeScene("s1");
    assert.deepEqual(facts!.tags.map((t) => t.tag), ["mine"]);
    assert.equal(facts!.note, undefined);
  });

  it("describes a whole drawing in one read", () => {
    scene(
      [
        el("b1", { customData: { tags: ["broken-code"] }, text: "Retry" }),
        el("l1", { customData: { link: { sceneId: "s2", name: "Other", render: "title" } } }),
      ],
      ["local-first"],
      { category: "Architecture/Storage", folder: "work/local-first" },
    );

    const facts = graph.describeScene("s1")!;
    assert.equal(facts.name, "Ingest pipeline");
    assert.equal(facts.category, "Architecture/Storage");
    assert.equal(facts.folder, "work/local-first");
    assert.deepEqual(facts.tags, [{ tag: "local-first", by: "scene" }]);
    assert.deepEqual(facts.boxes, [
      { elementId: "b1", label: "Retry", tags: ["broken-code"] },
    ]);
    assert.equal(facts.linksOut[0]!.sceneId, "s2");
  });

  it("returns nothing for a scene the graph has never seen", () => {
    assert.equal(graph.describeScene("nope"), null);
  });

  it("counts annotations separately from derived edges", () => {
    scene([], ["a"], { category: "C", folder: "F" });
    graph.annotate("s1", { tags: ["b"] });
    const s = graph.stats();
    assert.equal(s.annotated, 1);
    assert.equal(s.categories, 1);
    assert.equal(s.folders, 1);
    assert.equal(s.byKind["filed-under"], 1);
    assert.equal(s.byKind["lives-in"], 1);
  });

  it("forgets a scene entirely when it is deleted", () => {
    scene([el("b1", { customData: { tags: ["t"] } })], ["u"]);
    graph.removeScene("s1");
    assert.deepEqual(graph.listTags(), []);
    assert.equal(graph.stats().nodes, 0);
    assert.equal(graph.stats().edges, 0);
  });

  it("counts edges by kind", () => {
    scene(
      [
        el("b1", { customData: { tags: ["a"] } }),
        el("l1", { customData: { link: { sceneId: "s2" } } }),
      ],
      ["b"],
    );
    const s = graph.stats();
    assert.equal(s.byKind.tagged, 1);
    assert.equal(s.byKind["tagged-part"], 1);
    assert.equal(s.byKind["links-to"], 1);
    assert.equal(s.byKind.contains, 1);
  });

  it("survives a round trip through graph.json", () => {
    scene([el("b1", { customData: { tags: ["persisted"] } })], ["scene-tag"]);
    graph.flush(true);
    const written = JSON.parse(fs.readFileSync(graph.graphFile(), "utf8"));
    assert.equal(written.version, 1);
    assert.ok(written.nodes["tag:persisted"]);
    // scene->tag, scene->box, box->tag
    assert.equal(written.edges.length, 3);
  });
});
