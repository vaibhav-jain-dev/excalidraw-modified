/**
 * Layout templates.
 *
 * An agent asking for "a flowchart" should not have to invent coordinates —
 * that is where generated diagrams go wrong: overlapping boxes, arrows that
 * cross, spacing that drifts. Each template here takes CONTENT and returns a
 * finished `SemanticScene` with the geometry already solved, which
 * `saveSceneFromSemantic` compiles straight to elements.
 *
 * Adding one: keep the input shape flat and obvious, lay out on a grid with
 * the shared constants below, and register it in `TEMPLATES` so
 * `list_templates` stays accurate without anyone updating a doc.
 */

import type { SemanticEdge, SemanticNode, SemanticScene } from "./semantic.ts";

const W = 200;
const H = 80;
const GAP_X = 90;
const GAP_Y = 70;

const PALETTE = {
  step: "#a5d8ff",
  decision: "#ffec99",
  start: "#b2f2bb",
  end: "#ffc9c9",
  note: "#ffec99",
  lane: "#e0dfff",
};

type Str = string | { text: string; note?: string };

const asText = (value: Str): string =>
  typeof value === "string" ? value : String(value?.text ?? "");

const node = (
  id: string,
  text: string,
  x: number,
  y: number,
  bg: string,
  shape: SemanticNode["shape"] = "rectangle",
  w = W,
  h = H,
): SemanticNode => ({ id, shape, text, x, y, w, h, bg, fill: "solid" });

const edge = (from: string, to: string, text?: string): SemanticEdge => ({
  id: `e_${from}_${to}`,
  from,
  to,
  style: "arrow",
  ...(text ? { text } : {}),
});

const empty = (name: string): SemanticScene => ({
  name,
  nodes: [],
  edges: [],
  texts: [],
  sketches: [],
});

// ---------------------------------------------------------------------------

export interface FlowchartSpec {
  title?: string;
  steps: Str[];
  /** "down" (default) or "right" */
  direction?: "down" | "right";
  /** round the first and last step and colour them as start/end */
  endpoints?: boolean;
}

const flowchart = (spec: FlowchartSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Flowchart");
  const down = spec.direction !== "right";
  const steps = spec.steps ?? [];

  steps.forEach((step, i) => {
    const id = `n${i + 1}`;
    const first = i === 0;
    const last = i === steps.length - 1;
    const bg =
      spec.endpoints && first
        ? PALETTE.start
        : spec.endpoints && last
          ? PALETTE.end
          : PALETTE.step;
    const shape: SemanticNode["shape"] =
      spec.endpoints && (first || last) ? "ellipse" : "rectangle";
    scene.nodes.push(
      node(
        id,
        asText(step),
        down ? 0 : i * (W + GAP_X),
        down ? i * (H + GAP_Y) : 0,
        bg,
        shape,
      ),
    );
    if (i > 0) {
      scene.edges.push(edge(`n${i}`, id));
    }
  });
  return scene;
};

export interface DecisionSpec {
  title?: string;
  question: string;
  yes: Str[];
  no: Str[];
  /** optional step every branch rejoins */
  then?: string;
}

const decision = (spec: DecisionSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Decision");
  scene.nodes.push(node("q", spec.question, 0, 0, PALETTE.decision, "diamond"));

  const branch = (items: Str[], side: -1 | 1, label: string) => {
    let prev = "q";
    items.forEach((item, i) => {
      const id = `${label}${i + 1}`;
      scene.nodes.push(
        node(
          id,
          asText(item),
          side * (W + GAP_X),
          (i + 1) * (H + GAP_Y),
          PALETTE.step,
        ),
      );
      scene.edges.push(edge(prev, id, i === 0 ? label : undefined));
      prev = id;
    });
    return prev;
  };

  const lastYes = branch(spec.yes ?? [], -1, "yes");
  const lastNo = branch(spec.no ?? [], 1, "no");

  if (spec.then) {
    const rows = Math.max(spec.yes?.length ?? 0, spec.no?.length ?? 0);
    scene.nodes.push(
      node("end", spec.then, 0, (rows + 1) * (H + GAP_Y), PALETTE.end),
    );
    if (lastYes !== "q") {
      scene.edges.push(edge(lastYes, "end"));
    }
    if (lastNo !== "q") {
      scene.edges.push(edge(lastNo, "end"));
    }
  }
  return scene;
};

export interface SwimlaneSpec {
  title?: string;
  lanes: Array<{ name: string; steps: Str[] }>;
}

const swimlane = (spec: SwimlaneSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Swimlanes");
  const LABEL_W = 150;

  (spec.lanes ?? []).forEach((lane, row) => {
    const y = row * (H + GAP_Y);
    scene.nodes.push(
      node(`lane${row + 1}`, lane.name, 0, y, PALETTE.lane, "rectangle", LABEL_W),
    );
    (lane.steps ?? []).forEach((step, i) => {
      const id = `l${row + 1}s${i + 1}`;
      scene.nodes.push(
        node(id, asText(step), LABEL_W + GAP_X + i * (W + GAP_X), y, PALETTE.step),
      );
      if (i > 0) {
        scene.edges.push(edge(`l${row + 1}s${i}`, id));
      }
    });
  });
  return scene;
};

export interface MindmapSpec {
  title?: string;
  centre: string;
  branches: Array<{ label: string; children?: Str[] }>;
}

const mindmap = (spec: MindmapSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Mind map");
  const branches = spec.branches ?? [];
  const RING = 340;

  scene.nodes.push(node("c", spec.centre, 0, 0, PALETTE.lane, "ellipse"));

  branches.forEach((branch, i) => {
    const angle = (i / Math.max(1, branches.length)) * Math.PI * 2 - Math.PI / 2;
    const bx = Math.round(Math.cos(angle) * RING);
    const by = Math.round(Math.sin(angle) * RING);
    const id = `b${i + 1}`;
    scene.nodes.push(node(id, branch.label, bx, by, PALETTE.step));
    scene.edges.push({ id: `e_c_${id}`, from: "c", to: id, style: "line" });

    // children hang on the OUTER side of their branch, in a column centred on
    // it — a full box-width clear, so a child can never sit on its parent
    const children = branch.children ?? [];
    const CH = 60;
    const CGAP = 24;
    const outward = bx >= 0 ? 1 : -1;
    const columnTop = by - ((children.length - 1) * (CH + CGAP)) / 2;
    children.forEach((child, j) => {
      const cid = `${id}c${j + 1}`;
      scene.nodes.push(
        node(
          cid,
          asText(child),
          bx + outward * (W + GAP_X),
          Math.round(columnTop + j * (CH + CGAP)),
          PALETTE.note,
          "rectangle",
          W,
          CH,
        ),
      );
      scene.edges.push({ id: `e_${id}_${cid}`, from: id, to: cid, style: "line" });
    });
  });
  return scene;
};

export interface KanbanSpec {
  title?: string;
  columns: Array<{ name: string; cards?: Str[] }>;
}

const kanban = (spec: KanbanSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Board");
  const CARD_H = 70;

  (spec.columns ?? []).forEach((column, col) => {
    const x = col * (W + GAP_X);
    scene.nodes.push(
      node(`col${col + 1}`, column.name, x, 0, PALETTE.lane, "rectangle", W, 60),
    );
    (column.cards ?? []).forEach((card, i) => {
      scene.nodes.push({
        ...node(
          `c${col + 1}_${i + 1}`,
          asText(card),
          x,
          90 + i * (CARD_H + 20),
          PALETTE.note,
          "rectangle",
          W,
          CARD_H,
        ),
        sticky: true,
      });
    });
  });
  return scene;
};

export interface TimelineSpec {
  title?: string;
  events: Array<{ when: string; label: string }>;
}

const timeline = (spec: TimelineSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Timeline");
  (spec.events ?? []).forEach((event, i) => {
    const x = i * (W + GAP_X);
    scene.nodes.push(
      node(`t${i + 1}`, event.when, x, 0, PALETTE.lane, "ellipse", W, 60),
    );
    scene.nodes.push(node(`e${i + 1}`, event.label, x, 130, PALETTE.step));
    scene.edges.push({
      id: `e_t${i + 1}_e${i + 1}`,
      from: `t${i + 1}`,
      to: `e${i + 1}`,
      style: "line",
    });
    if (i > 0) {
      scene.edges.push(edge(`t${i}`, `t${i + 1}`));
    }
  });
  return scene;
};

export interface MatrixSpec {
  title?: string;
  rows: string[];
  columns: string[];
  /** cells[row][column] — missing entries are left empty */
  cells?: string[][];
}

const matrix = (spec: MatrixSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Matrix");
  const CW = 180;
  const CH = 90;
  const GAP = 20;

  (spec.columns ?? []).forEach((column, c) => {
    scene.nodes.push(
      node(`h${c + 1}`, column, (c + 1) * (CW + GAP), 0, PALETTE.lane, "rectangle", CW, 60),
    );
  });
  (spec.rows ?? []).forEach((row, r) => {
    const y = (r + 1) * (CH + GAP);
    scene.nodes.push(node(`r${r + 1}`, row, 0, y, PALETTE.lane, "rectangle", CW, CH));
    (spec.columns ?? []).forEach((_, c) => {
      const value = spec.cells?.[r]?.[c] ?? "";
      scene.nodes.push(
        node(`m${r + 1}_${c + 1}`, value, (c + 1) * (CW + GAP), y, PALETTE.step, "rectangle", CW, CH),
      );
    });
  });
  return scene;
};

// ---------------------------------------------------------------------------

export interface TemplateInfo {
  name: string;
  takes: string;
  gives: string;
}

const REGISTRY = {
  flowchart: {
    build: flowchart as (spec: any) => SemanticScene,
    takes: "steps[], direction: down|right, endpoints: bool, title",
    gives: "one chain of boxes joined by arrows",
  },
  decision: {
    build: decision as (spec: any) => SemanticScene,
    takes: "question, yes[], no[], then, title",
    gives: "a diamond splitting into two branches that can rejoin",
  },
  swimlane: {
    build: swimlane as (spec: any) => SemanticScene,
    takes: "lanes[{name, steps[]}], title",
    gives: "one labelled row per lane, steps left to right",
  },
  mindmap: {
    build: mindmap as (spec: any) => SemanticScene,
    takes: "centre, branches[{label, children[]}], title",
    gives: "a hub with branches radiating around it",
  },
  kanban: {
    build: kanban as (spec: any) => SemanticScene,
    takes: "columns[{name, cards[]}], title",
    gives: "columns of sticky notes",
  },
  timeline: {
    build: timeline as (spec: any) => SemanticScene,
    takes: "events[{when, label}], title",
    gives: "a left-to-right spine with a label under each point",
  },
  matrix: {
    build: matrix as (spec: any) => SemanticScene,
    takes: "rows[], columns[], cells[][], title",
    gives: "a labelled grid",
  },
} as const;

export type TemplateName = keyof typeof REGISTRY;

export const TEMPLATE_NAMES = Object.keys(REGISTRY) as TemplateName[];

export const listTemplates = (): TemplateInfo[] =>
  TEMPLATE_NAMES.map((name) => ({
    name,
    takes: REGISTRY[name].takes,
    gives: REGISTRY[name].gives,
  }));

export class UnknownTemplateError extends Error {
  constructor(name: string) {
    super(
      `unknown template "${name}" — available: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
}

export const buildTemplate = (
  name: string,
  spec: Record<string, unknown>,
): SemanticScene => {
  const entry = REGISTRY[name as TemplateName];
  if (!entry) {
    throw new UnknownTemplateError(name);
  }
  return entry.build(spec ?? {});
};
