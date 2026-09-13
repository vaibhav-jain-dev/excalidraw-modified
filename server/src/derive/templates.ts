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

export interface ArchitectureSpec {
  title?: string;
  /** top tier first; each tier is a row */
  tiers: Array<{ name?: string; nodes: Array<{ label: string; sub?: string }> }>;
  /** extra edges by node label, for shapes the auto-wiring cannot infer */
  links?: Array<[string, string]>;
}

/**
 * Auto-wiring, deliberately predictable: if the tier above has exactly one
 * node everything hangs off it; if the two tiers are the same width they join
 * index to index; otherwise nothing is wired and `links` decides. Guessing
 * beyond that produces arrows nobody asked for.
 */
const architecture = (spec: ArchitectureSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Architecture");
  const tiers = spec.tiers ?? [];
  const LABEL_W = 150;
  const idOf = new Map<string, string>();

  tiers.forEach((tier, row) => {
    const y = row * (H + GAP_Y + 20);
    if (tier.name) {
      scene.nodes.push(
        node(`tier${row + 1}`, tier.name, -(LABEL_W + GAP_X), y, PALETTE.lane, "rectangle", LABEL_W),
      );
    }
    (tier.nodes ?? []).forEach((entry, col) => {
      const id = `t${row + 1}n${col + 1}`;
      const label = entry.sub ? `${entry.label}\n${entry.sub}` : entry.label;
      scene.nodes.push(node(id, label, col * (W + GAP_X), y, PALETTE.step));
      if (!idOf.has(entry.label)) {
        idOf.set(entry.label, id);
      }
    });
  });

  tiers.forEach((tier, row) => {
    if (row === 0) {
      return;
    }
    const above = tiers[row - 1]?.nodes ?? [];
    const here = tier.nodes ?? [];
    here.forEach((_, col) => {
      const target =
        above.length === 1 ? 0 : above.length === here.length ? col : -1;
      if (target >= 0) {
        scene.edges.push(edge(`t${row}n${target + 1}`, `t${row + 1}n${col + 1}`));
      }
    });
  });

  for (const [from, to] of spec.links ?? []) {
    const a = idOf.get(from);
    const b = idOf.get(to);
    if (a && b) {
      scene.edges.push(edge(a, b));
    }
  }
  return scene;
};

export interface SequenceSpec {
  title?: string;
  actors: string[];
  messages: Array<{ from: string; to: string; text?: string }>;
}

/**
 * Messages are drawn as lines with labels rather than as edges: an edge in
 * this model joins two boxes, but a sequence message has to land at a
 * particular height on a lifeline, which an edge cannot express.
 */
const sequence = (spec: SequenceSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Sequence");
  const actors = spec.actors ?? [];
  const messages = spec.messages ?? [];
  const LANE = W + GAP_X;
  const TOP = 70;
  const STEP = 90;
  const laneX = (i: number) => i * LANE + W / 2;

  actors.forEach((actor, i) => {
    scene.nodes.push(node(`a${i + 1}`, actor, i * LANE, 0, PALETTE.lane, "rectangle", W, 60));
  });

  const depth = TOP + Math.max(1, messages.length) * STEP;
  actors.forEach((_, i) => {
    scene.sketches.push({
      id: `life${i + 1}`,
      kind: "line",
      from: [laneX(i), 60],
      to: [laneX(i), depth],
      color: "#b8b8b8",
    });
  });

  messages.forEach((message, i) => {
    const from = actors.indexOf(message.from);
    const to = actors.indexOf(message.to);
    if (from < 0 || to < 0 || from === to) {
      return;
    }
    const y = TOP + i * STEP;
    const x1 = laneX(from);
    const x2 = laneX(to);
    scene.sketches.push({ id: `m${i + 1}`, kind: "line", from: [x1, y], to: [x2, y] });
    const head = x2 > x1 ? -14 : 14;
    scene.sketches.push({
      id: `m${i + 1}h`,
      kind: "path",
      points: [
        [x2 + head, y - 7],
        [x2, y],
        [x2 + head, y + 7],
      ],
    });
    if (message.text) {
      scene.texts.push({
        id: `mt${i + 1}`,
        text: message.text,
        x: Math.min(x1, x2) + 12,
        y: y - 26,
        fontSize: 16,
      });
    }
  });
  return scene;
};

export interface StateMachineSpec {
  title?: string;
  states: string[];
  transitions: Array<{ from: string; to: string; on?: string }>;
  initial?: string;
}

const statemachine = (spec: StateMachineSpec): SemanticScene => {
  const scene = empty(spec.title ?? "States");
  const states = spec.states ?? [];
  const index = new Map(states.map((state, i) => [state, `s${i + 1}`]));

  states.forEach((state, i) => {
    const isInitial = spec.initial ? state === spec.initial : i === 0;
    scene.nodes.push(
      node(
        `s${i + 1}`,
        state,
        i * (W + GAP_X),
        0,
        isInitial ? PALETTE.start : PALETTE.step,
        "ellipse",
      ),
    );
  });

  (spec.transitions ?? []).forEach((transition, i) => {
    const from = index.get(transition.from);
    const to = index.get(transition.to);
    if (!from || !to) {
      return;
    }
    if (from === to) {
      // a self-transition has no second box to point at; label it instead
      const at = states.indexOf(transition.from);
      scene.texts.push({
        id: `loop${i + 1}`,
        text: `↺ ${transition.on ?? "self"}`,
        x: at * (W + GAP_X) + 20,
        y: -46,
        fontSize: 16,
      });
      return;
    }
    scene.edges.push(edge(from, to, transition.on));
  });
  return scene;
};

export interface ErdSpec {
  title?: string;
  entities: Array<{ name: string; fields?: string[] }>;
  relations?: Array<{ from: string; to: string; label?: string }>;
}

const erd = (spec: ErdSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Data model");
  const entities = spec.entities ?? [];
  const COLS = 3;
  const EW = 220;
  const ROW_H = 24;
  const index = new Map<string, string>();

  const rowHeights: number[] = [];
  entities.forEach((entity, i) => {
    const h = 54 + (entity.fields?.length ?? 0) * ROW_H;
    const row = Math.floor(i / COLS);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, h);
  });

  entities.forEach((entity, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const y = rowHeights
      .slice(0, row)
      .reduce((sum, h) => sum + h + GAP_Y, 0);
    const id = `e${i + 1}`;
    index.set(entity.name, id);
    const label = [entity.name, ...(entity.fields ?? [])].join("\n");
    scene.nodes.push(
      node(id, label, col * (EW + GAP_X), y, PALETTE.lane, "rectangle", EW, rowHeights[row]!),
    );
  });

  (spec.relations ?? []).forEach((relation) => {
    const from = index.get(relation.from);
    const to = index.get(relation.to);
    if (from && to && from !== to) {
      scene.edges.push(edge(from, to, relation.label));
    }
  });
  return scene;
};

export interface LayersSpec {
  title?: string;
  /** top layer first */
  layers: Array<{ name: string; items?: Str[] }>;
}

const layers = (spec: LayersSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Layers");
  const bands = spec.layers ?? [];
  const PAD = 24;
  const ITEM_W = 190;
  const ITEM_H = 64;
  const BAND_H = ITEM_H + PAD * 2 + 34;

  bands.forEach((band, i) => {
    const items = band.items ?? [];
    const width = Math.max(1, items.length) * (ITEM_W + 16) - 16 + PAD * 2;
    const y = i * (BAND_H + 28);
    scene.nodes.push(
      node(`band${i + 1}`, band.name, 0, y, PALETTE.lane, "rectangle", width, BAND_H),
    );
    items.forEach((item, j) => {
      scene.nodes.push(
        node(
          `b${i + 1}i${j + 1}`,
          asText(item),
          PAD + j * (ITEM_W + 16),
          y + 34 + PAD,
          PALETTE.step,
          "rectangle",
          ITEM_W,
          ITEM_H,
        ),
      );
    });
  });
  return scene;
};

export interface QuadrantSpec {
  title?: string;
  /** [left, right] */
  xAxis?: [string, string];
  /** [bottom, top] */
  yAxis?: [string, string];
  /** x and y are 0..1 from the bottom-left corner */
  items?: Array<{ label: string; x?: number; y?: number }>;
}

const quadrant = (spec: QuadrantSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Quadrant");
  const SIDE = 560;
  const IW = 150;
  const IH = 48;
  const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));

  scene.nodes.push({
    id: "frame",
    shape: "rectangle",
    x: 0,
    y: 0,
    w: SIDE,
    h: SIDE,
    bg: "transparent",
  });
  scene.sketches.push(
    { id: "vsplit", kind: "line", from: [SIDE / 2, 0], to: [SIDE / 2, SIDE] },
    { id: "hsplit", kind: "line", from: [0, SIDE / 2], to: [SIDE, SIDE / 2] },
  );

  const [left, right] = spec.xAxis ?? ["low", "high"];
  const [bottom, top] = spec.yAxis ?? ["low", "high"];
  scene.texts.push(
    { id: "ax1", text: left, x: -10, y: SIDE + 20, fontSize: 16 },
    { id: "ax2", text: right, x: SIDE - 60, y: SIDE + 20, fontSize: 16 },
    { id: "ay1", text: bottom, x: -90, y: SIDE - 30, fontSize: 16 },
    { id: "ay2", text: top, x: -90, y: 10, fontSize: 16 },
  );

  (spec.items ?? []).forEach((item, i) => {
    const x = clamp(item.x ?? 0.5) * (SIDE - IW);
    // y is read from the bottom, the way a chart is
    const y = (1 - clamp(item.y ?? 0.5)) * (SIDE - IH);
    scene.nodes.push({
      ...node(`q${i + 1}`, asText(item.label), Math.round(x), Math.round(y), PALETTE.note, "rectangle", IW, IH),
      sticky: true,
    });
  });
  return scene;
};

export interface WireframeSpec {
  title?: string;
  device?: "browser" | "phone";
  /** stacked content blocks, top to bottom */
  blocks?: Array<{ label: string; height?: number }>;
  nav?: string[];
}

/** A UI sketch scaffold — the frame, a chrome bar, then blocks to fill in. */
const wireframe = (spec: WireframeSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Wireframe");
  const phone = spec.device === "phone";
  const FW = phone ? 390 : 1000;
  const PAD = phone ? 16 : 28;
  const CHROME = 52;

  const nav = spec.nav ?? [];
  const blocks = spec.blocks ?? [];
  const inner = FW - PAD * 2;
  let y = CHROME + PAD;

  const navH = nav.length ? 44 : 0;
  const bodyH = blocks.reduce((sum, b) => sum + (b.height ?? 120) + 16, 0);
  const FH = CHROME + PAD + navH + (navH ? 16 : 0) + bodyH + PAD;

  scene.nodes.push({
    id: "frame",
    shape: "rectangle",
    x: 0,
    y: 0,
    w: FW,
    h: FH,
    bg: "transparent",
  });
  // chrome, not a fake status bar: a plain title strip the sketch sits under
  scene.nodes.push(
    node("chrome", spec.title ?? "", 0, 0, PALETTE.lane, "rectangle", FW, CHROME),
  );

  if (nav.length) {
    const each = Math.floor((inner - (nav.length - 1) * 12) / nav.length);
    nav.forEach((label, i) => {
      scene.nodes.push(
        node(`nav${i + 1}`, label, PAD + i * (each + 12), y, PALETTE.step, "rectangle", each, navH),
      );
    });
    y += navH + 16;
  }

  blocks.forEach((block, i) => {
    const h = block.height ?? 120;
    scene.nodes.push(
      node(`blk${i + 1}`, block.label, PAD, y, PALETTE.note, "rectangle", inner, h),
    );
    y += h + 16;
  });
  return scene;
};

export interface VennSpec {
  title?: string;
  /** two or three sets */
  sets: Str[];
  /** what sits in the overlap */
  overlap?: string;
}

const venn = (spec: VennSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Venn");
  const sets = (spec.sets ?? []).slice(0, 3);
  const R = 260;
  // centres must sit closer together than a diameter or the circles never
  // meet — 0.62R gives a readable lens without burying either label
  const STEP = Math.round(R * 0.62);
  const spots: Array<[number, number]> =
    sets.length >= 3
      ? [
          [0, 0],
          [STEP, 0],
          [Math.round(STEP / 2), Math.round(R * 0.55)],
        ]
      : [
          [0, 0],
          [STEP, 0],
        ];
  const fills = [PALETTE.step, PALETTE.note, PALETTE.start];

  sets.forEach((set, i) => {
    const [x, y] = spots[i] ?? [0, 0];
    scene.nodes.push({
      id: `v${i + 1}`,
      shape: "ellipse",
      x: Math.round(x),
      y: Math.round(y),
      w: R,
      h: R,
      bg: fills[i % fills.length],
      fill: "hachure",
    });
    scene.texts.push({
      id: `vt${i + 1}`,
      text: asText(set),
      x: Math.round(x + 40),
      y: Math.round(y - 34),
      fontSize: 20,
    });
  });

  if (spec.overlap && sets.length >= 2) {
    scene.texts.push({
      id: "voverlap",
      text: spec.overlap,
      x: Math.round(STEP / 2 + R / 2 - 60),
      y: Math.round(R / 2 - 10),
      fontSize: 16,
    });
  }
  return scene;
};

export interface StoryboardSpec {
  title?: string;
  frames: Str[];
  columns?: number;
}

const storyboard = (spec: StoryboardSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Storyboard");
  const frames = spec.frames ?? [];
  const cols = Math.max(1, Math.min(6, Number(spec.columns) || 4));
  const FW = 240;
  const FH = 160;
  const GAP = 28;
  const CAPTION = 46;

  frames.forEach((frame, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (FW + GAP);
    const y = row * (FH + CAPTION + GAP + 12);
    scene.nodes.push({
      id: `f${i + 1}`,
      shape: "rectangle",
      x,
      y,
      w: FW,
      h: FH,
      bg: "transparent",
    });
    scene.nodes.push(
      node(`cap${i + 1}`, `${i + 1}. ${asText(frame)}`, x, y + FH + 12, PALETTE.note, "rectangle", FW, CAPTION),
    );
  });
  return scene;
};

export interface OrgNode {
  label: string;
  sub?: string;
  children?: OrgNode[];
}

export interface OrgChartSpec {
  title?: string;
  root?: OrgNode;
}

/**
 * A tidy tree: leaves take the next slot left to right, and every parent
 * centres over its own children. That is what keeps a deep chart from
 * drifting sideways, and it is why this is not just `architecture` with
 * nesting.
 */
const orgchart = (spec: OrgChartSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Org chart");
  const root = spec.root;
  if (!root) {
    return scene;
  }
  const SLOT = W + 40;
  let leaf = 0;
  let n = 0;

  const place = (entry: OrgNode, depth: number, parentId: string | null): number => {
    const id = `o${(n += 1)}`;
    const children = entry.children ?? [];
    let x: number;
    if (!children.length) {
      x = (leaf += 1) * SLOT - SLOT;
    } else {
      const xs = children.map((child) => place(child, depth + 1, id));
      x = Math.round((xs[0]! + xs[xs.length - 1]!) / 2);
    }
    scene.nodes.push(
      node(
        id,
        entry.sub ? `${entry.label}\n${entry.sub}` : entry.label,
        x,
        depth * (H + GAP_Y),
        depth === 0 ? PALETTE.lane : PALETTE.step,
      ),
    );
    if (parentId) {
      scene.edges.push(edge(parentId, id));
    }
    return x;
  };

  place(root, 0, null);
  return scene;
};

export interface GanttSpec {
  title?: string;
  /** start/end are unit indices; end is exclusive */
  tasks: Array<{ label: string; start?: number; end?: number }>;
  /** column headings, e.g. ["Mar", "Apr", "May"] */
  units?: string[];
}

const gantt = (spec: GanttSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Plan");
  const tasks = spec.tasks ?? [];
  const LABEL_W = 220;
  const UNIT = 90;
  const ROW_H = 56;
  const TOP = 56;

  // declared columns win: a task running past the last one is clamped to it,
  // rather than silently stretching the chart to fit a typo
  const span = spec.units?.length
    ? spec.units.length
    : Math.max(1, ...tasks.map((t) => Number(t.end ?? 1)));

  (spec.units ?? []).forEach((unit, i) => {
    scene.nodes.push(
      node(`u${i + 1}`, unit, LABEL_W + i * UNIT, 0, PALETTE.lane, "rectangle", UNIT, 44),
    );
  });

  tasks.forEach((task, i) => {
    const y = TOP + i * (ROW_H + 12);
    const start = Math.max(0, Math.min(span - 1, Number(task.start) || 0));
    const end = Math.max(start + 1, Math.min(span, Number(task.end ?? start + 1)));
    scene.nodes.push(
      node(`l${i + 1}`, task.label, 0, y, PALETTE.lane, "rectangle", LABEL_W - 20, ROW_H),
    );
    scene.nodes.push(
      node(
        `bar${i + 1}`,
        "",
        LABEL_W + start * UNIT,
        y,
        PALETTE.step,
        "rectangle",
        (end - start) * UNIT,
        ROW_H,
      ),
    );
  });
  return scene;
};

export interface FunnelSpec {
  title?: string;
  stages: Str[];
  /** "down" narrows towards the bottom (a funnel); "up" is a pyramid */
  direction?: "down" | "up";
}

const funnel = (spec: FunnelSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Funnel");
  const stages = spec.stages ?? [];
  const MAX_W = 620;
  const MIN_W = 200;
  const SH = 84;
  const up = spec.direction === "up";
  const fills = [PALETTE.step, PALETTE.note, PALETTE.start, PALETTE.end, PALETTE.lane];

  stages.forEach((stage, i) => {
    const t = stages.length === 1 ? 0 : i / (stages.length - 1);
    const ratio = up ? 1 - t : t;
    const w = Math.round(MAX_W - ratio * (MAX_W - MIN_W));
    scene.nodes.push(
      node(
        `s${i + 1}`,
        asText(stage),
        Math.round((MAX_W - w) / 2),
        i * (SH + 14),
        fills[i % fills.length]!,
        "rectangle",
        w,
        SH,
      ),
    );
  });
  return scene;
};

export interface CycleSpec {
  title?: string;
  steps: Str[];
}

/** Steps on a ring, each pointing at the next, the last closing the loop. */
const cycle = (spec: CycleSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Cycle");
  const steps = spec.steps ?? [];
  if (!steps.length) {
    return scene;
  }
  // the ring has to be big enough that neighbouring boxes cannot touch
  const radius = Math.max(
    220,
    Math.round((steps.length * (W + 70)) / (2 * Math.PI)),
  );

  steps.forEach((step, i) => {
    const angle = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
    scene.nodes.push(
      node(
        `c${i + 1}`,
        asText(step),
        Math.round(Math.cos(angle) * radius),
        Math.round(Math.sin(angle) * radius),
        PALETTE.step,
      ),
    );
  });
  steps.forEach((_, i) => {
    scene.edges.push(edge(`c${i + 1}`, `c${((i + 1) % steps.length) + 1}`));
  });
  return scene;
};

export interface FishboneSpec {
  title?: string;
  problem: string;
  causes: Array<{ label: string; items?: Str[] }>;
}

/** Cause and effect: a spine running into the problem, bones alternating. */
const fishbone = (spec: FishboneSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Cause and effect");
  const causes = spec.causes ?? [];
  const SPINE_Y = 0;
  const STEP_X = 300;
  const ARM = 190;
  const length = (causes.length + 1) * STEP_X;

  scene.nodes.push(
    node("problem", spec.problem ?? "", length, SPINE_Y - H / 2, PALETTE.end, "rectangle", 240),
  );
  scene.sketches.push({
    id: "spine",
    kind: "line",
    from: [0, SPINE_Y],
    to: [length, SPINE_Y],
  });

  causes.forEach((cause, i) => {
    const up = i % 2 === 0;
    const x = (i + 1) * STEP_X - 240;
    const y = up ? SPINE_Y - ARM - H : SPINE_Y + ARM;
    scene.nodes.push(node(`c${i + 1}`, cause.label, x, y, PALETTE.lane));
    scene.sketches.push({
      id: `bone${i + 1}`,
      kind: "line",
      from: [x + W / 2, up ? y + H : y],
      to: [(i + 1) * STEP_X, SPINE_Y],
    });
    (cause.items ?? []).forEach((item, j) => {
      scene.nodes.push(
        node(
          `c${i + 1}i${j + 1}`,
          asText(item),
          x - 230,
          y + j * 70 + (up ? -40 : 40),
          PALETTE.note,
          "rectangle",
          210,
          56,
        ),
      );
    });
  });
  return scene;
};

export interface ProsConsSpec {
  title?: string;
  subject?: string;
  pros?: Str[];
  cons?: Str[];
}

const proscons = (spec: ProsConsSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Pros and cons");
  const COL_W = 320;
  const ITEM_H = 64;
  let top = 0;

  if (spec.subject) {
    scene.nodes.push(
      node("subject", spec.subject, 0, 0, PALETTE.lane, "rectangle", COL_W * 2 + GAP_X, 64),
    );
    top = 64 + 24;
  }

  const column = (
    items: Str[],
    x: number,
    heading: string,
    bg: string,
    prefix: string,
  ) => {
    scene.nodes.push(
      node(`${prefix}head`, heading, x, top, bg, "rectangle", COL_W, 56),
    );
    items.forEach((item, i) => {
      scene.nodes.push(
        node(
          `${prefix}${i + 1}`,
          asText(item),
          x,
          top + 56 + 16 + i * (ITEM_H + 12),
          bg,
          "rectangle",
          COL_W,
          ITEM_H,
        ),
      );
    });
  };

  column(spec.pros ?? [], 0, "Pros", PALETTE.start, "pro");
  column(spec.cons ?? [], COL_W + GAP_X, "Cons", PALETTE.end, "con");
  return scene;
};

export interface NetworkSpec {
  title?: string;
  nodes: Str[];
  /** [from, to] or [from, to, label], by node label */
  edges?: Array<[string, string] | [string, string, string]>;
}

/**
 * The escape hatch: arbitrary nodes and edges when no shaped template fits.
 * Laid out on a ring sized to the node count, so nothing ever overlaps and
 * the result is deterministic rather than a physics simulation.
 */
const network = (spec: NetworkSpec): SemanticScene => {
  const scene = empty(spec.title ?? "Network");
  const items = spec.nodes ?? [];
  if (!items.length) {
    return scene;
  }
  const radius = Math.max(
    200,
    Math.round((items.length * (W + 70)) / (2 * Math.PI)),
  );
  const index = new Map<string, string>();

  items.forEach((item, i) => {
    const label = asText(item);
    const id = `n${i + 1}`;
    index.set(label, id);
    const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
    scene.nodes.push(
      node(
        id,
        label,
        Math.round(Math.cos(angle) * radius),
        Math.round(Math.sin(angle) * radius),
        PALETTE.step,
      ),
    );
  });

  for (const entry of spec.edges ?? []) {
    const from = index.get(entry[0]);
    const to = index.get(entry[1]);
    if (from && to && from !== to) {
      scene.edges.push(edge(from, to, entry[2]));
    }
  }
  return scene;
};

// ---------------------------------------------------------------------------

export interface TemplateInfo {
  name: string;
  takes: string;
  gives: string;
  /**
   * A spec that actually builds. Prose describing a shape leaves an agent
   * guessing at it; a working example does not. The tests build from these,
   * so a documented example that stopped working fails the suite.
   */
  example: Record<string, unknown>;
}

const REGISTRY = {
  flowchart: {
    build: flowchart as (spec: any) => SemanticScene,
    takes: "steps[], direction: down|right, endpoints: bool, title",
    gives: "one chain of boxes joined by arrows",
    example: { steps: ["Watch", "Parse", "Index"], endpoints: true },
  },
  decision: {
    build: decision as (spec: any) => SemanticScene,
    takes: "question, yes[], no[], then, title",
    gives: "a diamond splitting into two branches that can rejoin",
    example: { question: "Parsed?", yes: ["Index"], no: ["Retry", "Quarantine"], then: "Done" },
  },
  swimlane: {
    build: swimlane as (spec: any) => SemanticScene,
    takes: "lanes[{name, steps[]}], title",
    gives: "one labelled row per lane, steps left to right",
    example: { lanes: [{ name: "Editor", steps: ["Save"] }, { name: "Server", steps: ["Derive", "Index"] }] },
  },
  mindmap: {
    build: mindmap as (spec: any) => SemanticScene,
    takes: "centre, branches[{label, children[]}], title",
    gives: "a hub with branches radiating around it",
    example: { centre: "Local-first", branches: [{ label: "Storage", children: ["SQLite", "graph.json"] }, { label: "Search" }, { label: "MCP" }] },
  },
  kanban: {
    build: kanban as (spec: any) => SemanticScene,
    takes: "columns[{name, cards[]}], title",
    gives: "columns of sticky notes",
    example: { columns: [{ name: "Todo", cards: ["A", "B"] }, { name: "Done", cards: ["C"] }] },
  },
  timeline: {
    build: timeline as (spec: any) => SemanticScene,
    takes: "events[{when, label}], title",
    gives: "a left-to-right spine with a label under each point",
    example: { events: [{ when: "Mar", label: "Fork" }, { when: "Apr", label: "Graph" }] },
  },
  matrix: {
    build: matrix as (spec: any) => SemanticScene,
    takes: "rows[], columns[], cells[][], title",
    gives: "a labelled grid",
    example: { rows: ["Fast", "Slow"], columns: ["Cheap", "Dear"], cells: [["yes", "no"]] },
  },
  architecture: {
    build: architecture as (spec: any) => SemanticScene,
    takes: "tiers[{name, nodes[{label, sub}]}], links[[a,b]], title",
    gives: "services in tiers, wired top-down; sub is a second line (a port, a runtime)",
    example: { tiers: [{ name: "control", nodes: [{ label: "base-fe", sub: ":3064" }] }, { name: "apps", nodes: [{ label: "fieldwork", sub: ":3065" }, { label: "common", sub: ":3066" }, { label: "lms", sub: ":3067" }] }], links: [["fieldwork", "common"]] },
  },
  sequence: {
    build: sequence as (spec: any) => SemanticScene,
    takes: "actors[], messages[{from, to, text}], title",
    gives: "lifelines with labelled arrows between them, in order",
    example: { actors: ["Editor", "API", "Worker"], messages: [{ from: "Editor", to: "API", text: "PUT /scenes/:id" }, { from: "API", to: "Worker", text: "enqueue index" }, { from: "Worker", to: "API", text: "done" }] },
  },
  statemachine: {
    build: statemachine as (spec: any) => SemanticScene,
    takes: "states[], transitions[{from, to, on}], initial, title",
    gives: "states in a row with labelled transitions; self-transitions become a label",
    example: { states: ["queued", "running", "done"], transitions: [{ from: "queued", to: "running", on: "drain" }, { from: "running", to: "done", on: "ok" }, { from: "running", to: "running", on: "retry" }] },
  },
  erd: {
    build: erd as (spec: any) => SemanticScene,
    takes: "entities[{name, fields[]}], relations[{from, to, label}], title",
    gives: "entity boxes listing their fields, joined by labelled relations",
    example: { entities: [{ name: "scene", fields: ["id", "name", "category"] }, { name: "version", fields: ["scene_id", "n"] }], relations: [{ from: "scene", to: "version", label: "1:N" }] },
  },
  layers: {
    build: layers as (spec: any) => SemanticScene,
    takes: "layers[{name, items[]}], title",
    gives: "stacked bands, each holding its own items",
    example: { layers: [{ name: "UI", items: ["dashboard", "editor"] }, { name: "API", items: ["REST", "MCP"] }, { name: "Store", items: ["SQLite", "graph.json"] }] },
  },
  quadrant: {
    build: quadrant as (spec: any) => SemanticScene,
    takes: "xAxis[left,right], yAxis[bottom,top], items[{label, x, y}] (0..1), title",
    gives: "a 2x2 with labelled axes and sticky notes plotted in it",
    example: { xAxis: ["cheap", "costly"], yAxis: ["low impact", "high impact"], items: [{ label: "graph store", x: 0.1, y: 0.9 }, { label: "editor UI", x: 0.85, y: 0.85 }, { label: "cluster names", x: 0.15, y: 0.1 }] },
  },
  wireframe: {
    build: wireframe as (spec: any) => SemanticScene,
    takes: "device browser|phone, nav[], blocks[{label, height}], title",
    gives: "a UI sketch scaffold: frame, chrome strip, nav, stacked blocks",
    example: { device: "browser", title: "Library", nav: ["All", "Pinned", "Tags"], blocks: [{ label: "search + filters", height: 80 }, { label: "card grid" }] },
  },
  venn: {
    build: venn as (spec: any) => SemanticScene,
    takes: "sets[] (two or three), overlap, title",
    gives: "overlapping circles with labels",
    example: { sets: ["derived", "authored"], overlap: "the graph" },
  },
  storyboard: {
    build: storyboard as (spec: any) => SemanticScene,
    takes: "frames[], columns, title",
    gives: "numbered empty frames with a caption under each",
    example: { frames: ["open library", "pick a drawing", "read-only view", "edit"] },
  },
  orgchart: {
    build: orgchart as (spec: any) => SemanticScene,
    takes: "root{label, sub, children[...]}, title",
    gives: "a tidy tree, every parent centred over its children",
    example: { root: { label: "workspace", children: [{ label: "base-fe", sub: ":3064", children: [{ label: "registry" }, { label: "runtime" }] }, { label: "apps", children: [{ label: "fieldwork" }, { label: "lms" }] }] } },
  },
  gantt: {
    build: gantt as (spec: any) => SemanticScene,
    takes: "tasks[{label, start, end}], units[], title",
    gives: "a bar per task across labelled time columns",
    example: { units: ["Mar", "Apr", "May", "Jun"], tasks: [{ label: "graph store", start: 0, end: 2 }, { label: "search ladder", start: 1, end: 3 }, { label: "editor UI", start: 2, end: 4 }] },
  },
  funnel: {
    build: funnel as (spec: any) => SemanticScene,
    takes: "stages[], direction down|up, title",
    gives: "stages narrowing downward, or widening upward as a pyramid",
    example: { stages: ["visitors", "signups", "active", "paying"] },
  },
  cycle: {
    build: cycle as (spec: any) => SemanticScene,
    takes: "steps[], title",
    gives: "steps on a ring, each arrow returning to the start",
    example: { steps: ["draw", "save", "index", "search"] },
  },
  fishbone: {
    build: fishbone as (spec: any) => SemanticScene,
    takes: "problem, causes[{label, items[]}], title",
    gives: "a spine running into the problem, causes branching off it",
    example: { problem: "thumbnail wrong", causes: [{ label: "layout", items: ["flex min-size"] }, { label: "render", items: ["scene bbox"] }, { label: "data", items: ["sparse board"] }] },
  },
  proscons: {
    build: proscons as (spec: any) => SemanticScene,
    takes: "subject, pros[], cons[], title",
    gives: "two coloured columns under an optional subject",
    example: { subject: "JSON graph store", pros: ["no migration per edge kind", "readable on disk"], cons: ["loaded whole into memory"] },
  },
  network: {
    build: network as (spec: any) => SemanticScene,
    takes: "nodes[], edges[[from, to, label]], title",
    gives: "arbitrary nodes on a ring with the edges you name — the escape hatch",
    example: { nodes: ["editor", "api", "worker", "sqlite", "graph.json"], edges: [["editor", "api", "save"], ["api", "worker", "enqueue"], ["worker", "sqlite"], ["api", "graph.json"]] },
  },
} as const;

export type TemplateName = keyof typeof REGISTRY;

export const TEMPLATE_NAMES = Object.keys(REGISTRY) as TemplateName[];

export const listTemplates = (): TemplateInfo[] =>
  TEMPLATE_NAMES.map((name) => ({
    name,
    takes: REGISTRY[name].takes,
    gives: REGISTRY[name].gives,
    example: REGISTRY[name].example as Record<string, unknown>,
  }));

/** The worked example for one template, for tests and for `apply_template`. */
export const templateExample = (name: string): Record<string, unknown> =>
  (REGISTRY[name as TemplateName]?.example ?? {}) as Record<string, unknown>;

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
