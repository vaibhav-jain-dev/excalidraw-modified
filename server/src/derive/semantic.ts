/**
 * The bot-friendly JSON view of a scene.
 *
 * Raw `.excalidraw` elements are a flat list of geometry primitives — verbose
 * and hard for an LLM to author. `toSemantic` collapses them into a compact
 * `{ nodes, edges, texts, sketches }` graph; `fromSemantic` compiles that back
 * to elements (positions are optional — missing ones get a simple grid
 * layout). Even a freehand pencil stroke has a predefined shape here: a
 * `sketch` with `kind: "path"` and a points array, or `kind: "line"` with
 * `from`/`to`.
 *
 * The editor's `restoreElements` normalizes whatever we emit on load, so
 * `fromSemantic` only needs to produce "good enough" elements.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_STROKE = "#1e1e1e";
const TRANSPARENT = "transparent";
const DEFAULT_NODE_W = 180;
const DEFAULT_NODE_H = 100;
const GRID_GAP_X = 260;
const GRID_GAP_Y = 180;
const GRID_COLUMNS = 4;

export type SemanticShape = "rectangle" | "ellipse" | "diamond";

export interface SemanticNode {
  id: string;
  shape: SemanticShape;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  bg?: string;
  fill?: "solid" | "hachure" | "cross-hatch";
  sticky?: boolean;
  /** stable name for deep links / crop-to-element renders (`customData.anchor`) */
  anchor?: string;
}

export interface SemanticEdge {
  id: string;
  from: string;
  to: string;
  text?: string;
  style?: "arrow" | "line";
  dashed?: boolean;
}

export interface SemanticText {
  id: string;
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
  color?: string;
}

export interface SemanticSketch {
  id: string;
  kind: "path" | "line";
  /** absolute scene coordinates */
  points?: Array<[number, number]>;
  from?: [number, number];
  to?: [number, number];
  color?: string;
  strokeWidth?: number;
}

export interface SemanticScene {
  name?: string;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  texts: SemanticText[];
  sketches: SemanticSketch[];
}

type AnyElement = Record<string, any>;

const round = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;

const elementId = (): string => randomBytes(12).toString("base64url").slice(0, 20);

const rnd = (): number => Math.floor(Math.random() * 2 ** 31);

// ===========================================================================
// elements -> semantic
// ===========================================================================

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

export const toSemantic = (elements: readonly AnyElement[]): SemanticScene => {
  const live = elements.filter((el) => el && !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el]));

  const labelByContainer = new Map<string, string>();
  const boundTextIds = new Set<string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId) {
      boundTextIds.add(el.id);
      if (typeof el.text === "string" && el.text.trim()) {
        labelByContainer.set(el.containerId, el.text);
      }
    }
  }

  const nodes: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const texts: SemanticText[] = [];
  const sketches: SemanticSketch[] = [];

  for (const el of live) {
    if (SHAPE_TYPES.has(el.type) || el.type === "stickyNote") {
      const node: SemanticNode = {
        id: el.id,
        shape: el.type === "stickyNote" ? "rectangle" : el.type,
        x: round(el.x),
        y: round(el.y),
        w: round(el.width) || DEFAULT_NODE_W,
        h: round(el.height) || DEFAULT_NODE_H,
      };
      const label =
        labelByContainer.get(el.id) ??
        (el.type === "stickyNote" && typeof el.text === "string"
          ? el.text
          : undefined);
      if (label) {
        node.text = label;
      }
      if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) {
        node.color = el.strokeColor;
      }
      if (el.backgroundColor && el.backgroundColor !== TRANSPARENT) {
        node.bg = el.backgroundColor;
        if (el.fillStyle && el.fillStyle !== "hachure") {
          node.fill = el.fillStyle;
        }
      }
      if (el.type === "stickyNote") {
        node.sticky = true;
      }
      if (typeof el.customData?.anchor === "string") {
        node.anchor = el.customData.anchor;
      }
      nodes.push(node);
      continue;
    }

    if (el.type === "arrow" || el.type === "line") {
      const from = el.startBinding?.elementId;
      const to = el.endBinding?.elementId;
      if (from && to && byId.has(from) && byId.has(to)) {
        const edge: SemanticEdge = {
          id: el.id,
          from,
          to,
          style: el.type === "arrow" ? "arrow" : "line",
        };
        const label = labelByContainer.get(el.id);
        if (label) {
          edge.text = label;
        }
        if (el.strokeStyle === "dashed" || el.strokeStyle === "dotted") {
          edge.dashed = true;
        }
        edges.push(edge);
      } else {
        const pts: Array<[number, number]> = Array.isArray(el.points)
          ? el.points.map((p: [number, number]) => [
              round(el.x + p[0]),
              round(el.y + p[1]),
            ])
          : [];
        if (pts.length >= 2) {
          sketches.push({
            id: el.id,
            kind: "line",
            from: pts[0],
            to: pts[pts.length - 1],
            ...(el.strokeColor && el.strokeColor !== DEFAULT_STROKE
              ? { color: el.strokeColor }
              : {}),
          });
        }
      }
      continue;
    }

    if (el.type === "text" && !boundTextIds.has(el.id)) {
      if (typeof el.text === "string" && el.text.trim()) {
        const text: SemanticText = {
          id: el.id,
          text: el.text,
          x: round(el.x),
          y: round(el.y),
        };
        if (el.fontSize && el.fontSize !== 20) {
          text.fontSize = round(el.fontSize);
        }
        if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) {
          text.color = el.strokeColor;
        }
        texts.push(text);
      }
      continue;
    }

    if (el.type === "freedraw" && Array.isArray(el.points)) {
      const points: Array<[number, number]> = el.points.map(
        (p: [number, number]) => [round(el.x + p[0]), round(el.y + p[1])],
      );
      if (points.length >= 2) {
        const sketch: SemanticSketch = { id: el.id, kind: "path", points };
        if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) {
          sketch.color = el.strokeColor;
        }
        if (el.strokeWidth && el.strokeWidth !== 2) {
          sketch.strokeWidth = el.strokeWidth;
        }
        sketches.push(sketch);
      }
    }
  }

  return { nodes, edges, texts, sketches };
};

// ===========================================================================
// semantic -> elements
// ===========================================================================

const baseElement = (type: string, overrides: AnyElement): AnyElement => ({
  id: elementId(),
  type,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: DEFAULT_STROKE,
  backgroundColor: TRANSPARENT,
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: type === "rectangle" ? { type: 3 } : null,
  seed: rnd(),
  version: 1,
  versionNonce: rnd(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  index: null,
  ...overrides,
});

interface PlacedNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

const layoutNodes = (nodes: SemanticNode[]): Map<string, PlacedNode> => {
  const placed = new Map<string, PlacedNode>();
  let autoIndex = 0;
  for (const node of nodes) {
    const w = node.w ?? DEFAULT_NODE_W;
    const h = node.h ?? DEFAULT_NODE_H;
    let { x, y } = node;
    if (x == null || y == null) {
      x = (autoIndex % GRID_COLUMNS) * GRID_GAP_X;
      y = Math.floor(autoIndex / GRID_COLUMNS) * GRID_GAP_Y;
      autoIndex += 1;
    }
    placed.set(node.id, { x, y, w, h });
  }
  return placed;
};

const center = (n: PlacedNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

export const fromSemantic = (scene: Partial<SemanticScene>): AnyElement[] => {
  const nodes = scene.nodes ?? [];
  const edges = scene.edges ?? [];
  const texts = scene.texts ?? [];
  const sketches = scene.sketches ?? [];

  const placed = layoutNodes(nodes);
  const elements: AnyElement[] = [];
  const bound = new Map<string, Array<{ type: string; id: string }>>();
  const addBound = (ownerId: string, ref: { type: string; id: string }) => {
    const list = bound.get(ownerId) ?? [];
    list.push(ref);
    bound.set(ownerId, list);
  };

  for (const node of nodes) {
    const box = placed.get(node.id)!;
    const el = baseElement(node.sticky ? "rectangle" : node.shape, {
      id: node.id,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      strokeColor: node.color ?? DEFAULT_STROKE,
      backgroundColor: node.bg ?? (node.sticky ? "#ffdf6b" : TRANSPARENT),
      fillStyle: node.fill ?? "solid",
      customData: node.anchor ? { anchor: node.anchor } : undefined,
    });
    elements.push(el);

    if (node.text) {
      const textEl = baseElement("text", {
        x: box.x + 8,
        y: box.y + box.h / 2 - 12,
        width: Math.max(20, box.w - 16),
        height: 25,
        text: node.text,
        originalText: node.text,
        fontSize: 20,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: node.id,
        lineHeight: 1.25,
        autoResize: true,
        roundness: null,
      });
      elements.push(textEl);
      addBound(node.id, { type: "text", id: textEl.id });
    }
  }

  for (const edge of edges) {
    const fromBox = placed.get(edge.from);
    const toBox = placed.get(edge.to);
    if (!fromBox || !toBox) {
      continue;
    }
    const a = center(fromBox);
    const b = center(toBox);
    const el = baseElement("arrow", {
      id: edge.id,
      x: a.x,
      y: a.y,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      points: [
        [0, 0],
        [b.x - a.x, b.y - a.y],
      ],
      startBinding: { elementId: edge.from, focus: 0, gap: 4 },
      endBinding: { elementId: edge.to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: edge.style === "line" ? null : "arrow",
      strokeStyle: edge.dashed ? "dashed" : "solid",
      roundness: { type: 2 },
      elbowed: false,
    });
    elements.push(el);
    addBound(edge.from, { type: "arrow", id: el.id });
    addBound(edge.to, { type: "arrow", id: el.id });

    if (edge.text) {
      const textEl = baseElement("text", {
        x: (a.x + b.x) / 2 - 30,
        y: (a.y + b.y) / 2 - 12,
        width: 60,
        height: 25,
        text: edge.text,
        originalText: edge.text,
        fontSize: 16,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: el.id,
        lineHeight: 1.25,
        autoResize: true,
        roundness: null,
      });
      elements.push(textEl);
      addBound(el.id, { type: "text", id: textEl.id });
    }
  }

  for (const text of texts) {
    elements.push(
      baseElement("text", {
        id: text.id,
        x: text.x ?? 0,
        y: text.y ?? 0,
        width: Math.max(20, text.text.length * 9),
        height: (text.fontSize ?? 20) * 1.25,
        text: text.text,
        originalText: text.text,
        fontSize: text.fontSize ?? 20,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        strokeColor: text.color ?? DEFAULT_STROKE,
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
        roundness: null,
      }),
    );
  }

  for (const sketch of sketches) {
    const abs: Array<[number, number]> =
      sketch.kind === "line"
        ? [sketch.from ?? [0, 0], sketch.to ?? [0, 0]]
        : sketch.points ?? [];
    const first = abs[0];
    if (abs.length < 2 || !first) {
      continue;
    }
    const [ox, oy] = first;
    const rel = abs.map(([x, y]): [number, number] => [x - ox, y - oy]);
    const xs = abs.map(([x]) => x);
    const ys = abs.map(([, y]) => y);
    elements.push(
      baseElement("freedraw", {
        id: sketch.id,
        x: ox,
        y: oy,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        points: rel,
        pressures: [],
        simulatePressure: true,
        strokeColor: sketch.color ?? DEFAULT_STROKE,
        strokeWidth: sketch.strokeWidth ?? 2,
        roundness: null,
      }),
    );
  }

  // attach collected bindings
  const boundById = new Map(elements.map((el) => [el.id, el]));
  for (const [ownerId, refs] of bound) {
    const owner = boundById.get(ownerId);
    if (owner) {
      owner.boundElements = refs;
    }
  }

  return elements;
};

/** Merge a semantic fragment into an existing scene's elements. */
export const mergeSemantic = (
  existing: readonly AnyElement[],
  fragment: Partial<SemanticScene>,
): AnyElement[] => {
  const current = toSemantic(existing);
  const merged: SemanticScene = {
    nodes: [...current.nodes, ...(fragment.nodes ?? [])],
    edges: [...current.edges, ...(fragment.edges ?? [])],
    texts: [...current.texts, ...(fragment.texts ?? [])],
    sketches: [...current.sketches, ...(fragment.sketches ?? [])],
  };
  return fromSemantic(merged);
};

// ===========================================================================
// semantic -> markdown (read-only, for humans and grep)
// ===========================================================================

export const toMarkdown = (
  scene: SemanticScene,
  title = "Untitled",
): string => {
  const lines: string[] = [`# ${title}`, ""];
  const nameOf = (id: string) =>
    scene.nodes.find((n) => n.id === id)?.text || id;

  if (scene.nodes.length) {
    lines.push("## Nodes", "");
    for (const node of scene.nodes) {
      lines.push(
        `- ${node.text ? `**${node.text}**` : "(unlabeled)"} — ${node.shape}${
          node.sticky ? " (sticky note)" : ""
        }`,
      );
    }
    lines.push("");
  }
  if (scene.edges.length) {
    lines.push("## Connections", "");
    for (const edge of scene.edges) {
      const arrow = edge.style === "line" ? "—" : "→";
      lines.push(
        `- ${nameOf(edge.from)} ${arrow} ${nameOf(edge.to)}${
          edge.text ? `: ${edge.text}` : ""
        }`,
      );
    }
    lines.push("");
  }
  if (scene.texts.length) {
    lines.push("## Notes", "");
    for (const text of scene.texts) {
      lines.push(`- ${text.text.replace(/\n/g, " ")}`);
    }
    lines.push("");
  }
  if (scene.sketches.length) {
    lines.push("## Sketches", "");
    for (const sketch of scene.sketches) {
      lines.push(
        sketch.kind === "line"
          ? `- freehand line`
          : `- freehand path (${sketch.points?.length ?? 0} points)`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
};
