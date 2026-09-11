import assert from "node:assert/strict";
import { test } from "node:test";

import { toSemantic } from "./semantic.ts";
import { isGraphShaped, toMermaid } from "./mermaid.ts";

test("toMermaid renders nodes, edges and shapes", () => {
  const scene = {
    nodes: [
      { id: "a", shape: "rectangle" as const, text: "Ingest" },
      { id: "b", shape: "diamond" as const, text: "Valid?" },
      { id: "c", shape: "ellipse" as const, text: "Done" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c", text: "yes" },
    ],
    texts: [{ id: "t1", text: "a free note" }],
    sketches: [],
  };

  const mermaid = toMermaid(scene);
  assert.match(mermaid, /^flowchart TD/);
  assert.match(mermaid, /na\["Ingest"\]/);
  assert.match(mermaid, /nb\{"Valid\?"\}/);
  assert.match(mermaid, /nc\(\("Done"\)\)/);
  assert.match(mermaid, /na --> nb/);
  assert.match(mermaid, /nb -->\|"yes"\| nc/);
  assert.match(mermaid, /a free note/);
});

test("isGraphShaped is false for a scene with only free text/sketches", () => {
  const scene = toSemantic([
    { id: "t", type: "text", x: 0, y: 0, text: "just a note" },
  ]);
  assert.equal(isGraphShaped(scene), false);
});

test("anchors round-trip through the semantic graph", async () => {
  const { fromSemantic } = await import("./semantic.ts");
  const elements = fromSemantic({
    nodes: [{ id: "a", shape: "rectangle", text: "Kafka", anchor: "ingest" }],
  });
  const back = toSemantic(elements);
  assert.equal(back.nodes[0]?.anchor, "ingest");
});
