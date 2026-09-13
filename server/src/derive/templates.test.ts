import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTemplate,
  listTemplates,
  TEMPLATE_NAMES,
  templateExample,
  UnknownTemplateError,
} from "./templates.ts";
import { fromSemantic } from "./semantic.ts";

const inside = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/**
 * The bar for a layout template: nothing may sit on top of anything else.
 * Full containment is exempt — an item inside a band or a lane is deliberate.
 */
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
        b.y < a.y + a.h &&
        !inside(a, b) &&
        !inside(b, a)
      ) {
        hits.push(`${a.id}/${b.id}`);
      }
    }
  }
  return hits;
};

/** venn circles overlap by design — that is the diagram, not a layout bug */
const OVERLAP_EXEMPT = new Set(["venn"]);

describe("diagram templates", () => {
  it("registers every template it advertises", () => {
    const listed = listTemplates().map((t) => t.name).sort();
    assert.deepEqual(listed, [...TEMPLATE_NAMES].sort());
    for (const info of listTemplates()) {
      assert.ok(info.takes.length > 0, `${info.name} documents its input`);
      assert.ok(info.gives.length > 0, `${info.name} documents its output`);
      // the example an agent will copy has to be the one that is exercised
      assert.deepEqual(info.example, templateExample(info.name));
    }
  });

  it("ships a worked example for every registered template", () => {
    for (const info of listTemplates()) {
      assert.ok(
        info.example && Object.keys(info.example).length > 0,
        `${info.name} documents a usable example`,
      );
    }
  });

  for (const name of TEMPLATE_NAMES) {
    it(`${name}: lays out without overlapping anything`, (t) => {
      if (OVERLAP_EXEMPT.has(name)) {
        t.skip("overlapping shapes are the point of this one");
        return;
      }
      const scene = buildTemplate(name, templateExample(name));
      assert.ok(scene.nodes.length > 0, "produced nodes");
      assert.deepEqual(overlaps(scene), [], "no two nodes overlap");
    });

    it(`${name}: every edge points at a node that exists`, () => {
      const scene = buildTemplate(name, templateExample(name));
      const ids = new Set(scene.nodes.map((n) => n.id));
      for (const edge of scene.edges) {
        assert.ok(ids.has(edge.from), `${edge.id} from ${edge.from}`);
        assert.ok(ids.has(edge.to), `${edge.id} to ${edge.to}`);
      }
    });

    it(`${name}: compiles to real elements`, () => {
      const scene = buildTemplate(name, templateExample(name));
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
    const scene = buildTemplate("flowchart", templateExample("flowchart"));
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
    const scene = buildTemplate("decision", templateExample("decision"));
    const labelled = scene.edges.filter((e) => e.text).map((e) => e.text);
    assert.deepEqual(labelled.sort(), ["no", "yes"]);
  });

  it("rejoins both decision branches when `then` is given", () => {
    const scene = buildTemplate("decision", templateExample("decision"));
    assert.equal(scene.edges.filter((e) => e.to === "end").length, 2);
  });

  it("wires an architecture tier that fans out from a single parent", () => {
    const scene = buildTemplate("architecture", templateExample("architecture"));
    const fromRoot = scene.edges.filter((e) => e.from === "t1n1");
    assert.equal(fromRoot.length, 3, "all three apps hang off base-fe");
  });

  it("joins architecture tiers index-to-index when they are the same width", () => {
    const scene = buildTemplate("architecture", {
      tiers: [
        { nodes: [{ label: "a" }, { label: "b" }] },
        { nodes: [{ label: "a-api" }, { label: "b-api" }] },
      ],
    });
    assert.deepEqual(
      scene.edges.map((e) => `${e.from}->${e.to}`),
      ["t1n1->t2n1", "t1n2->t2n2"],
    );
  });

  it("wires nothing it cannot infer, leaving it to links", () => {
    const scene = buildTemplate("architecture", {
      tiers: [
        { nodes: [{ label: "a" }, { label: "b" }] },
        { nodes: [{ label: "x" }, { label: "y" }, { label: "z" }] },
      ],
    });
    assert.deepEqual(scene.edges, []);
  });

  it("draws a lifeline per actor and an arrow per sequence message", () => {
    const scene = buildTemplate("sequence", templateExample("sequence"));
    assert.equal(scene.nodes.length, 3, "one box per actor");
    const lifelines = scene.sketches.filter((s) => s.id.startsWith("life"));
    assert.equal(lifelines.length, 3);
    assert.equal(scene.texts.length, 3, "each message is labelled");
    // messages run in order, down the page
    const ys = scene.texts.map((t) => t.y ?? 0);
    assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  });

  it("ignores a sequence message naming an actor that does not exist", () => {
    const scene = buildTemplate("sequence", {
      actors: ["A"],
      messages: [{ from: "A", to: "Ghost", text: "x" }],
    });
    assert.equal(scene.texts.length, 0);
  });

  it("labels a self-transition instead of drawing an edge to nowhere", () => {
    const scene = buildTemplate("statemachine", templateExample("statemachine"));
    assert.equal(scene.edges.length, 2, "only the two real transitions");
    assert.equal(scene.texts.length, 1);
    assert.match(scene.texts[0]!.text, /retry/);
  });

  it("marks the initial state differently", () => {
    const scene = buildTemplate("statemachine", templateExample("statemachine"));
    assert.notEqual(scene.nodes[0]!.bg, scene.nodes[1]!.bg);
  });

  it("sizes an entity row to its tallest entity, and aligns the row", () => {
    const scene = buildTemplate("erd", templateExample("erd"));
    // three fields plus the name has to fit
    assert.ok(scene.nodes[0]!.h! >= 54 + 3 * 24);
    // ...and neighbours in the same row match it, so the row reads as a row
    assert.equal(scene.nodes[0]!.h, scene.nodes[1]!.h);
    assert.equal(scene.nodes[0]!.y, scene.nodes[1]!.y);
  });

  it("lists an entity's fields under its name and labels the relation", () => {
    const scene = buildTemplate("erd", templateExample("erd"));
    assert.equal(scene.nodes[0]!.text, "scene\nid\nname\ncategory");
    assert.equal(scene.edges[0]!.text, "1:N");
  });

  it("starts a new entity row after three, without overlapping the one above", () => {
    const scene = buildTemplate("erd", {
      entities: Array.from({ length: 4 }, (_, i) => ({
        name: `e${i}`,
        fields: ["a"],
      })),
    });
    const first = scene.nodes[0]!;
    const fourth = scene.nodes[3]!;
    assert.equal(fourth.x, first.x, "wraps back to the first column");
    assert.ok(fourth.y! >= first.y! + first.h!, "and drops below the row above");
  });

  it("puts every layer item inside its own band", () => {
    const scene = buildTemplate("layers", templateExample("layers"));
    const band = scene.nodes.find((n) => n.id === "band1")!;
    const item = scene.nodes.find((n) => n.id === "b1i1")!;
    assert.ok(item.x! >= band.x! && item.y! >= band.y!);
    assert.ok(item.x! + item.w! <= band.x! + band.w!);
    assert.ok(item.y! + item.h! <= band.y! + band.h!);
  });

  it("plots quadrant items from the bottom-left, the way a chart reads", () => {
    const scene = buildTemplate("quadrant", templateExample("quadrant"));
    const byLabel = new Map(scene.nodes.map((n) => [n.text, n]));
    const high = byLabel.get("graph store")!;
    const low = byLabel.get("cluster names")!;
    // y: 0.9 is near the TOP, so its y coordinate must be the smaller one
    assert.ok(high.y! < low.y!);
    assert.equal(scene.texts.length, 4, "both ends of both axes are labelled");
  });

  it("keeps quadrant items inside the frame at the extremes", () => {
    const scene = buildTemplate("quadrant", {
      items: [
        { label: "corner", x: 1, y: 1 },
        { label: "other", x: 0, y: 0 },
      ],
    });
    const frame = scene.nodes.find((n) => n.id === "frame")!;
    for (const item of scene.nodes.filter((n) => n.id !== "frame")) {
      assert.ok(item.x! >= frame.x!);
      assert.ok(item.x! + item.w! <= frame.x! + frame.w!);
      assert.ok(item.y! + item.h! <= frame.y! + frame.h!);
    }
  });

  it("clamps quadrant coordinates instead of flinging items off the board", () => {
    const scene = buildTemplate("quadrant", {
      items: [{ label: "way out", x: 40, y: -12 }],
    });
    const frame = scene.nodes.find((n) => n.id === "frame")!;
    const item = scene.nodes.find((n) => n.id === "q1")!;
    assert.ok(item.x! + item.w! <= frame.x! + frame.w!);
    assert.ok(item.y! + item.h! <= frame.y! + frame.h!);
  });

  it("sizes a wireframe to its content and keeps blocks inside the frame", () => {
    const scene = buildTemplate("wireframe", templateExample("wireframe"));
    const frame = scene.nodes.find((n) => n.id === "frame")!;
    for (const block of scene.nodes.filter((n) => n.id.startsWith("blk"))) {
      assert.ok(block.y! + block.h! <= frame.y! + frame.h!, `${block.id} fits`);
      assert.ok(block.x! + block.w! <= frame.x! + frame.w!);
    }
  });

  it("narrows a phone wireframe", () => {
    const browser = buildTemplate("wireframe", { device: "browser", blocks: [{ label: "a" }] });
    const phone = buildTemplate("wireframe", { device: "phone", blocks: [{ label: "a" }] });
    assert.ok(phone.nodes[0]!.w! < browser.nodes[0]!.w!);
  });

  it("overlaps venn circles, which is the whole diagram", () => {
    const scene = buildTemplate("venn", templateExample("venn"));
    assert.equal(scene.nodes.length, 2);
    assert.ok(overlaps(scene).length > 0, "the circles must intersect");
    assert.equal(scene.texts.length, 3, "two set labels plus the overlap");
  });

  it("takes at most three venn sets", () => {
    const scene = buildTemplate("venn", { sets: ["a", "b", "c", "d"] });
    assert.equal(scene.nodes.length, 3);
  });

  it("numbers storyboard frames and wraps them into rows", () => {
    const scene = buildTemplate("storyboard", { frames: ["a", "b", "c"], columns: 2 });
    const captions = scene.nodes.filter((n) => n.id.startsWith("cap"));
    assert.deepEqual(
      captions.map((c) => c.text),
      ["1. a", "2. b", "3. c"],
    );
    // the third frame drops to a second row
    assert.ok(captions[2]!.y! > captions[1]!.y!);
    assert.equal(captions[2]!.x, captions[0]!.x);
  });

  it("centres every org chart parent over its own children", () => {
    const scene = buildTemplate("orgchart", templateExample("orgchart"));
    const byText = new Map(scene.nodes.map((n) => [n.text, n]));
    const apps = byText.get("apps")!;
    const fieldwork = byText.get("fieldwork")!;
    const lms = byText.get("lms")!;
    assert.equal(apps.x, Math.round((fieldwork.x! + lms.x!) / 2));
    // and the root sits above everything
    assert.equal(byText.get("workspace")!.y, 0);
    assert.ok(apps.y! > 0);
  });

  it("gives every org chart child an edge from its parent", () => {
    const scene = buildTemplate("orgchart", templateExample("orgchart"));
    assert.equal(scene.edges.length, scene.nodes.length - 1, "a tree, not a forest");
  });

  it("draws a gantt bar spanning exactly its units", () => {
    const scene = buildTemplate("gantt", templateExample("gantt"));
    const bar = scene.nodes.find((n) => n.id === "bar1")!;
    const unit0 = scene.nodes.find((n) => n.id === "u1")!;
    assert.equal(bar.x, unit0.x, "starts under its first column");
    assert.equal(bar.w, unit0.w! * 2, "two units wide");
  });

  it("clamps a gantt task that runs past the last unit", () => {
    const scene = buildTemplate("gantt", {
      units: ["Q1", "Q2"],
      tasks: [{ label: "forever", start: 0, end: 99 }],
    });
    const bar = scene.nodes.find((n) => n.id === "bar1")!;
    assert.equal(bar.w, 90 * 2);
  });

  it("narrows a funnel and widens a pyramid", () => {
    const down = buildTemplate("funnel", templateExample("funnel"));
    assert.ok(down.nodes[0]!.w! > down.nodes[3]!.w!);
    const up = buildTemplate("funnel", { stages: ["a", "b", "c"], direction: "up" });
    assert.ok(up.nodes[0]!.w! < up.nodes[2]!.w!);
  });

  it("closes the cycle back to the first step", () => {
    const scene = buildTemplate("cycle", templateExample("cycle"));
    assert.equal(scene.edges.length, 4);
    assert.equal(scene.edges[3]!.to, "c1", "the last step returns to the first");
  });

  it("grows the cycle ring so more steps still cannot collide", () => {
    const small = buildTemplate("cycle", { steps: ["a", "b", "c"] });
    const big = buildTemplate("cycle", { steps: Array.from({ length: 12 }, (_, i) => `s${i}`) });
    const spread = (s: typeof small) =>
      Math.max(...s.nodes.map((n) => n.x!)) - Math.min(...s.nodes.map((n) => n.x!));
    assert.ok(spread(big) > spread(small));
    assert.deepEqual(overlaps(big), []);
  });

  it("alternates fishbone causes above and below the spine", () => {
    const scene = buildTemplate("fishbone", templateExample("fishbone"));
    const c1 = scene.nodes.find((n) => n.id === "c1")!;
    const c2 = scene.nodes.find((n) => n.id === "c2")!;
    assert.ok(c1.y! < 0, "first cause above the spine");
    assert.ok(c2.y! > 0, "second below");
    assert.ok(scene.sketches.some((s) => s.id === "spine"));
  });

  it("colours pros and cons differently", () => {
    const scene = buildTemplate("proscons", templateExample("proscons"));
    const pro = scene.nodes.find((n) => n.id === "pro1")!;
    const con = scene.nodes.find((n) => n.id === "con1")!;
    assert.notEqual(pro.bg, con.bg);
    assert.ok(con.x! > pro.x!, "cons sit in the right-hand column");
  });

  it("wires a network by node label and ignores names it does not know", () => {
    const scene = buildTemplate("network", templateExample("network"));
    assert.equal(scene.edges.length, 4);
    assert.equal(scene.edges[0]!.text, "save");
    const ghost = buildTemplate("network", {
      nodes: ["a"],
      edges: [["a", "nobody"]],
    });
    assert.deepEqual(ghost.edges, []);
  });

  it("names the unknown template and lists the real ones", () => {
    assert.throws(
      () => buildTemplate("sankey", {}),
      (error: Error) => {
        assert.ok(error instanceof UnknownTemplateError);
        assert.match(error.message, /sankey/);
        assert.match(error.message, /flowchart/);
        return true;
      },
    );
  });
});
