import assert from "node:assert/strict";
import { test } from "node:test";

import { fromSemantic, mergeSemantic, toMarkdown, toSemantic } from "./semantic.ts";

test("fromSemantic produces valid, restorable elements", () => {
  const elements = fromSemantic({
    nodes: [
      { id: "a", shape: "rectangle", text: "Kafka" },
      { id: "b", shape: "ellipse", text: "Store" },
    ],
    edges: [{ id: "e", from: "a", to: "b", text: "events" }],
    texts: [{ id: "t", text: "a note", x: 0, y: 300 }],
    sketches: [
      { id: "s", kind: "path", points: [[0, 400], [10, 410], [20, 400]] },
    ],
  });

  const byType = elements.reduce<Record<string, number>>((acc, el) => {
    acc[el.type] = (acc[el.type] ?? 0) + 1;
    return acc;
  }, {});
  // 1 rect + 1 ellipse + 1 arrow + 3 labels (2 nodes, 1 edge) + 1 free text + 1 sketch
  assert.equal(byType.rectangle, 1);
  assert.equal(byType.ellipse, 1);
  assert.equal(byType.arrow, 1);
  assert.equal(byType.text, 4);
  assert.equal(byType.freedraw, 1);

  for (const el of elements) {
    assert.ok(typeof el.seed === "number");
    assert.equal(el.version, 1);
    assert.equal(el.isDeleted, false);
  }

  const rect = elements.find((el) => el.id === "a");
  assert.ok(rect.boundElements?.some((b: any) => b.type === "text"));
});

test("toSemantic round-trips fromSemantic", () => {
  const graph = {
    nodes: [
      { id: "a", shape: "rectangle" as const, text: "One" },
      { id: "b", shape: "diamond" as const, text: "Two" },
    ],
    edges: [{ id: "e", from: "a", to: "b" }],
    texts: [],
    sketches: [
      { id: "s", kind: "path" as const, points: [[0, 0], [5, 5]] as [number, number][] },
    ],
  };

  const back = toSemantic(fromSemantic(graph));
  assert.equal(back.nodes.length, 2);
  assert.equal(back.nodes[0]?.text, "One");
  assert.equal(back.nodes[1]?.shape, "diamond");
  assert.equal(back.edges.length, 1);
  assert.equal(back.edges[0]?.from, "a");
  assert.equal(back.sketches.length, 1);
  assert.equal(back.sketches[0]?.points?.length, 2);
});

test("unbound arrows become line sketches, bound arrows become edges", () => {
  const scene = toSemantic([
    { id: "n1", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
    { id: "n2", type: "rectangle", x: 300, y: 0, width: 100, height: 50 },
    {
      id: "bound",
      type: "arrow",
      x: 0,
      y: 0,
      points: [[0, 0], [100, 0]],
      startBinding: { elementId: "n1" },
      endBinding: { elementId: "n2" },
    },
    {
      id: "loose",
      type: "arrow",
      x: 10,
      y: 200,
      points: [[0, 0], [50, 10]],
    },
  ]);
  assert.equal(scene.edges.length, 1);
  assert.equal(scene.edges[0]?.id, "bound");
  assert.equal(scene.sketches.length, 1);
  assert.equal(scene.sketches[0]?.kind, "line");
});

test("mergeSemantic keeps existing content and adds the fragment", () => {
  const base = fromSemantic({
    nodes: [{ id: "a", shape: "rectangle", text: "Base" }],
  });
  const merged = toSemantic(
    mergeSemantic(base, {
      nodes: [{ id: "b", shape: "ellipse", text: "Added" }],
      edges: [{ id: "e", from: "a", to: "b" }],
    }),
  );
  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.edges.length, 1);
});

test("toMarkdown renders a readable outline", () => {
  const md = toMarkdown(
    {
      nodes: [{ id: "a", shape: "rectangle", text: "Ingest" }],
      edges: [{ id: "e", from: "a", to: "a", text: "loop" }],
      texts: [{ id: "t", text: "todo" }],
      sketches: [],
    },
    "Flow",
  );
  assert.match(md, /^# Flow/);
  assert.match(md, /\*\*Ingest\*\*/);
  assert.match(md, /loop/);
  assert.match(md, /todo/);
});
