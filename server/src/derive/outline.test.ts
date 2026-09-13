import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toOutline, toSummary } from "./outline.ts";

const box = (id: string, x: number, y: number, w = 100, h = 60, extra = {}) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
  isDeleted: false,
  ...extra,
});

describe("scene outline", () => {
  it("collapses a freehand stroke to a bounding box and a point count", () => {
    const points = Array.from({ length: 214 }, (_, i) => [i, i]);
    const outline = toOutline([
      { id: "f1", type: "freedraw", x: 10, y: 20, width: 200, height: 80, points, isDeleted: false },
    ]);
    assert.deepEqual(outline.sketches, [
      { id: "f1", kind: "path", at: [10, 20, 200, 80], points: 214 },
    ]);
    // the whole point: the payload must not scale with the stroke
    assert.ok(JSON.stringify(outline).length < 400);
  });

  it("keeps the real element id so anything found can be acted on", () => {
    const outline = toOutline([box("el_real", 0, 0)]);
    assert.equal(outline.nodes[0]!.id, "el_real");
  });

  it("lifts bound text into its container's label instead of listing it twice", () => {
    const outline = toOutline([
      box("b1", 0, 0),
      { id: "t1", type: "text", containerId: "b1", text: "Retry queue", isDeleted: false },
    ]);
    assert.equal(outline.nodes[0]!.text, "Retry queue");
    assert.equal(outline.texts.length, 0);
  });

  it("records containment against the smallest enclosing node", () => {
    const outline = toOutline([
      box("outer", 0, 0, 500, 500),
      box("middle", 10, 10, 300, 300),
      box("inner", 20, 20, 50, 50),
    ]);
    const byId = new Map(outline.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("inner")!.in, "middle");
    assert.equal(byId.get("middle")!.in, "outer");
    assert.equal(byId.get("outer")!.in, undefined);
  });

  it("emits nodes in reading order, not element order", () => {
    const outline = toOutline([
      box("bottom-right", 400, 400),
      box("top-left", 0, 0),
      box("top-right", 400, 0),
    ]);
    assert.deepEqual(
      outline.nodes.map((n) => n.id),
      ["top-left", "top-right", "bottom-right"],
    );
  });

  it("groups elements into clusters by proximity", () => {
    const outline = toOutline([
      box("a", 0, 0),
      box("b", 120, 0),
      box("far", 3000, 3000),
    ]);
    assert.equal(outline.clusters.length, 2);
    assert.equal(outline.clusters[0]!.count, 2);
    assert.equal(outline.clusters[1]!.count, 1);
  });

  it("names a cluster from the labels inside it", () => {
    const outline = toOutline([
      box("a", 0, 0, 100, 60, { customData: {} }),
      { id: "t1", type: "text", containerId: "a", text: "Parser", isDeleted: false },
    ]);
    assert.equal(outline.clusters[0]!.gist, "Parser");
  });

  it("reads edges from arrow bindings", () => {
    const outline = toOutline([
      box("a", 0, 0),
      box("b", 300, 0),
      {
        id: "ar",
        type: "arrow",
        x: 100,
        y: 30,
        width: 200,
        height: 0,
        isDeleted: false,
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      },
    ]);
    assert.deepEqual(outline.edges, [{ id: "ar", from: "a", to: "b" }]);
  });

  it("counts what it drops instead of hiding it", () => {
    const outline = toOutline([
      { id: "e1", type: "embeddable", x: 0, y: 0, width: 10, height: 10, isDeleted: false },
      { id: "t0", type: "text", text: "   ", x: 0, y: 0, isDeleted: false },
    ]);
    assert.deepEqual(outline.omitted, { emptyText: 1, embeddable: 1 });
  });

  it("surfaces element tags so the graph and the drawing agree", () => {
    const outline = toOutline([box("a", 0, 0, 100, 60, { customData: { tags: ["broken-code"] } })]);
    assert.deepEqual(outline.nodes[0]!.tags, ["broken-code"]);
  });

  it("ignores deleted elements", () => {
    const outline = toOutline([box("gone", 0, 0, 100, 60, { isDeleted: true })]);
    assert.equal(outline.counts.nodes, 0);
    assert.equal(outline.bbox, null);
  });

  it("limits the outline to a region, and says what it left out", () => {
    const outline = toOutline(
      [box("in", 50, 50), box("also-in", 100, 100), box("far", 5000, 5000)],
      "Scene",
      [0, 0, 400, 400],
    );
    assert.deepEqual(
      outline.nodes.map((n) => n.id).sort(),
      ["also-in", "in"],
    );
    assert.deepEqual(outline.region, [0, 0, 400, 400]);
    assert.equal(outline.outsideRegion, 1);
  });

  it("keeps a shape's own label when reading a region", () => {
    const outline = toOutline(
      [
        box("b1", 10, 10),
        { id: "t1", type: "text", containerId: "b1", text: "Retry", isDeleted: false },
      ],
      "Scene",
      [0, 0, 200, 200],
    );
    assert.equal(outline.nodes[0]!.text, "Retry");
  });

  it("says nothing is there rather than returning the whole scene", () => {
    const outline = toOutline([box("far", 9000, 9000)], "Scene", [0, 0, 100, 100]);
    assert.equal(outline.counts.nodes, 0);
    assert.equal(outline.outsideRegion, 1);
  });

  it("carries the region through to the summary", () => {
    const summary = toSummary([box("a", 0, 0), box("far", 9000, 9000)], "S", [0, 0, 300, 300]);
    assert.equal(summary.counts.nodes, 1);
    assert.deepEqual(summary.region, [0, 0, 300, 300]);
  });

  it("summary carries orientation without any per-element detail", () => {
    const summary = toSummary([box("a", 0, 0), box("b", 120, 0)], "Ingest");
    assert.equal(summary.name, "Ingest");
    assert.equal(summary.counts.nodes, 2);
    assert.ok(summary.clusters.length >= 1);
    assert.equal((summary as Record<string, unknown>).nodes, undefined);
  });
});
