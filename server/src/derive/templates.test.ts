import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTemplate,
  listTemplates,
  TEMPLATE_NAMES,
  UnknownTemplateError,
} from "./templates.ts";
import { fromSemantic } from "./semantic.ts";

/** the bar for a layout template: nothing may sit on top of anything else */
const overlaps = (scene: ReturnType<typeof buildTemplate>) => {
  const boxes = scene.nodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: n.w ?? 0,
    h: n.h ?? 0,
  }));
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        hits.push(`${a.id}/${b.id}`);
      }
    }
  }
  return hits;
};

const SPECS: Record<string, Record<string, unknown>> = {
  flowchart: { steps: ["Watch", "Parse", "Index"], endpoints: true },
  decision: { question: "Parsed?", yes: ["Index"], no: ["Retry", "Quarantine"], then: "Done" },
  swimlane: {
    lanes: [
      { name: "Editor", steps: ["Save"] },
      { name: "Server", steps: ["Derive", "Index"] },
    ],
  },
  mindmap: {
    centre: "Local-first",
    branches: [
      { label: "Storage", children: ["SQLite", "graph.json"] },
      { label: "Search" },
      { label: "MCP" },
    ],
  },
  kanban: { columns: [{ name: "Todo", cards: ["A", "B"] }, { name: "Done", cards: ["C"] }] },
  timeline: { events: [{ when: "Mar", label: "Fork" }, { when: "Apr", label: "Graph" }] },
  matrix: { rows: ["Fast", "Slow"], columns: ["Cheap", "Dear"], cells: [["yes", "no"]] },
};

describe("diagram templates", () => {
  it("registers every template it advertises", () => {
    const listed = listTemplates().map((t) => t.name).sort();
    assert.deepEqual(listed, [...TEMPLATE_NAMES].sort());
    for (const info of listTemplates()) {
      assert.ok(info.takes.length > 0, `${info.name} documents its input`);
      assert.ok(info.gives.length > 0, `${info.name} documents its output`);
    }
  });

  it("has a worked example for every registered template", () => {
    assert.deepEqual(Object.keys(SPECS).sort(), [...TEMPLATE_NAMES].sort());
  });

  for (const name of TEMPLATE_NAMES) {
    it(`${name}: lays out without overlapping anything`, () => {
      const scene = buildTemplate(name, SPECS[name]!);
      assert.ok(scene.nodes.length > 0, "produced nodes");
      assert.deepEqual(overlaps(scene), [], "no two nodes overlap");
    });

    it(`${name}: every edge points at a node that exists`, () => {
      const scene = buildTemplate(name, SPECS[name]!);
      const ids = new Set(scene.nodes.map((n) => n.id));
      for (const edge of scene.edges) {
        assert.ok(ids.has(edge.from), `${edge.id} from ${edge.from}`);
        assert.ok(ids.has(edge.to), `${edge.id} to ${edge.to}`);
      }
    });

    it(`${name}: compiles to real elements`, () => {
      const scene = buildTemplate(name, SPECS[name]!);
      const elements = fromSemantic(scene);
      assert.ok(elements.length >= scene.nodes.length);
    });

    it(`${name}: survives an empty spec instead of throwing`, () => {
      const scene = buildTemplate(name, {});
      assert.ok(Array.isArray(scene.nodes));
      assert.ok(Array.isArray(scene.edges));
    });
  }

  it("chains flowchart steps in order", () => {
    const scene = buildTemplate("flowchart", SPECS.flowchart!);
    assert.deepEqual(
      scene.edges.map((e) => `${e.from}->${e.to}`),
      ["n1->n2", "n2->n3"],
    );
  });

  it("lays a flowchart down by default and right on request", () => {
    const down = buildTemplate("flowchart", { steps: ["a", "b"] });
    assert.equal(down.nodes[0]!.x, down.nodes[1]!.x);
    const right = buildTemplate("flowchart", { steps: ["a", "b"], direction: "right" });
    assert.equal(right.nodes[0]!.y, right.nodes[1]!.y);
  });

  it("labels the first edge of each decision branch", () => {
    const scene = buildTemplate("decision", SPECS.decision!);
    const labelled = scene.edges.filter((e) => e.text).map((e) => e.text);
    assert.deepEqual(labelled.sort(), ["no", "yes"]);
  });

  it("rejoins both decision branches when `then` is given", () => {
    const scene = buildTemplate("decision", SPECS.decision!);
    assert.equal(scene.edges.filter((e) => e.to === "end").length, 2);
  });

  it("names the unknown template and lists the real ones", () => {
    assert.throws(
      () => buildTemplate("gantt", {}),
      (error: Error) => {
        assert.ok(error instanceof UnknownTemplateError);
        assert.match(error.message, /gantt/);
        assert.match(error.message, /flowchart/);
        return true;
      },
    );
  });
});
