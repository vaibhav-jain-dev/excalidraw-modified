/**
 * The read-only, LLM-facing view of a scene.
 *
 * `semantic.ts` is the AUTHORING format: lossless, round-trippable, every
 * freehand point present, because `fromSemantic` has to rebuild real elements
 * from it. That makes it the wrong thing to hand a model that only wants to
 * know what a drawing is about — on a real scene here, one pencil stroke's
 * point array was 4.5 KB of a 5.5 KB payload describing two shapes.
 *
 * So this is a separate, deliberately LOSSY view. It never round-trips and
 * nothing writes through it. What it optimises for, in order:
 *
 *   1. Orientation before detail. `summary` and `clusters` answer "what is
 *      this and how is it arranged" in a few dozen tokens, so a model can
 *      decide whether to read further instead of paying for the whole scene.
 *   2. Precision. Every entry keeps its real element id, so anything found
 *      here can be tagged, linked, anchored or cropped without a second
 *      lookup.
 *   3. Structure over geometry. Containment (`in`) and reading order carry
 *      the meaning that raw coordinates only imply.
 *   4. Truthful omission. Dropped detail is always counted, never silently
 *      vanished: a stroke becomes its bounding box plus a point count.
 */

type AnyElement = Record<string, any>;

export interface OutlineNode {
  id: string;
  shape: string;
  text?: string;
  at: [number, number, number, number];
  /** id of the smallest node fully containing this one */
  in?: string;
  tags?: string[];
  anchor?: string;
  bg?: string;
}

export interface OutlineEdge {
  id: string;
  from?: string;
  to?: string;
  text?: string;
}

export interface OutlineText {
  id: string;
  text: string;
  at: [number, number];
  in?: string;
}

export interface OutlineSketch {
  id: string;
  kind: "path" | "line";
  at: [number, number, number, number];
  /** how many points were dropped — the geometry is in the raw scene */
  points: number;
  tags?: string[];
}

export interface OutlineCluster {
  at: [number, number, number, number];
  count: number;
  gist: string;
}

export type Region = [number, number, number, number];

export interface SceneOutline {
  name: string;
  /** set when the outline was limited to a region of the canvas */
  region?: Region;
  /** elements outside the region, not described */
  outsideRegion?: number;
  bbox: [number, number, number, number] | null;
  counts: Record<string, number>;
  clusters: OutlineCluster[];
  nodes: OutlineNode[];
  edges: OutlineEdge[];
  texts: OutlineText[];
  sketches: OutlineSketch[];
  /** anything deliberately not represented, so the omission is visible */
  omitted?: Record<string, number>;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "stickyNote", "image", "frame"]);
const LINES = new Set(["arrow", "line"]);

const r = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;

const boxOf = (el: AnyElement): [number, number, number, number] => [
  r(el.x),
  r(el.y),
  r(el.width),
  r(el.height),
];

const contains = (
  outer: [number, number, number, number],
  inner: [number, number, number, number],
): boolean =>
  inner[0] >= outer[0] &&
  inner[1] >= outer[1] &&
  inner[0] + inner[2] <= outer[0] + outer[2] &&
  inner[1] + inner[3] <= outer[1] + outer[3];

const area = (b: [number, number, number, number]): number => b[2] * b[3];

const readTags = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value.filter((t): t is string => typeof t === "string" && !!t.trim());
  return tags.length ? tags : undefined;
};

/**
 * Reading order: band by row, then left to right inside a band. Coordinates
 * alone do not say "this comes first"; a document order does, and it costs
 * nothing to emit the array already sorted.
 */
const readingOrder = <T extends { at: number[] }>(items: T[]): T[] => {
  if (!items.length) {
    return items;
  }
  const heights = items.map((i) => i.at[3] ?? 0).filter((h) => h > 0).sort((a, b) => a - b);
  const band = Math.max(40, heights[Math.floor(heights.length / 2)] ?? 80);
  return [...items].sort((a, b) => {
    const rowA = Math.floor((a.at[1] ?? 0) / band);
    const rowB = Math.floor((b.at[1] ?? 0) / band);
    return rowA - rowB || (a.at[0] ?? 0) - (b.at[0] ?? 0);
  });
};

/**
 * Group elements into loose regions by proximity — single-link clustering
 * with a gap threshold. This is what makes "the board has three areas" a
 * cheap answer instead of a scan, and it is the same computation the
 * thumbnail uses to pick a best area on an oversized board.
 */
const cluster = (
  boxes: Array<{ at: [number, number, number, number]; label: string }>,
  gap = 160,
): OutlineCluster[] => {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  };

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!.at;
      const b = boxes[j]!.at;
      const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
      const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
      if (dx <= gap && dy <= gap) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const key = find(i);
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  });

  const out: OutlineCluster[] = [];
  for (const members of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const labels: string[] = [];
    for (const i of members) {
      const [x, y, w, h] = boxes[i]!.at;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
      if (boxes[i]!.label) {
        labels.push(boxes[i]!.label);
      }
    }
    out.push({
      at: [r(x0), r(y0), r(x1 - x0), r(y1 - y0)],
      count: members.length,
      gist: labels.slice(0, 4).join(" · ") || "unlabelled",
    });
  }
  return out.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
};

const overlapsRegion = (el: AnyElement, region: Region): boolean => {
  const [rx, ry, rw, rh] = region;
  const x = Number(el.x) || 0;
  const y = Number(el.y) || 0;
  const w = Number(el.width) || 0;
  const h = Number(el.height) || 0;
  return x < rx + rw && rx < x + w && y < ry + rh && ry < y + h;
};

export const toOutline = (
  elements: readonly AnyElement[],
  name = "Untitled",
  region?: Region,
): SceneOutline => {
  const all = elements.filter((el) => el && !el.isDeleted);
  // a region read answers "what is inside that box" — the question a reviewer
  // asks by dragging a comment over part of the canvas. Bound text is kept
  // regardless of its own position so labels do not vanish from their shapes.
  const live = region
    ? all.filter(
        (el) =>
          overlapsRegion(el, region) ||
          (el.type === "text" && el.containerId),
      )
    : all;

  const labelByContainer = new Map<string, string>();
  const boundText = new Set<string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId) {
      boundText.add(el.id);
      if (typeof el.text === "string" && el.text.trim()) {
        labelByContainer.set(el.containerId, el.text.trim());
      }
    }
  }

  const nodes: OutlineNode[] = [];
  const edges: OutlineEdge[] = [];
  const texts: OutlineText[] = [];
  const sketches: OutlineSketch[] = [];
  const omitted: Record<string, number> = {};

  for (const el of live) {
    const custom = (el.customData ?? {}) as AnyElement;
    const tags = readTags(custom.tags);

    if (SHAPES.has(el.type)) {
      const label = (typeof el.text === "string" && el.text.trim()) || labelByContainer.get(el.id);
      const node: OutlineNode = { id: el.id, shape: el.type, at: boxOf(el) };
      if (label) {
        node.text = label;
      }
      if (tags) {
        node.tags = tags;
      }
      if (typeof custom.anchor === "string") {
        node.anchor = custom.anchor;
      }
      if (el.backgroundColor && el.backgroundColor !== "transparent") {
        node.bg = el.backgroundColor;
      }
      nodes.push(node);
    } else if (LINES.has(el.type)) {
      const edge: OutlineEdge = { id: el.id };
      const from = el.startBinding?.elementId;
      const to = el.endBinding?.elementId;
      if (from) {
        edge.from = from;
      }
      if (to) {
        edge.to = to;
      }
      const label = labelByContainer.get(el.id);
      if (label) {
        edge.text = label;
      }
      // an unbound arrow says nothing an LLM can use; keep it counted instead
      if (from || to || label) {
        edges.push(edge);
      } else {
        omitted.unboundArrows = (omitted.unboundArrows ?? 0) + 1;
        sketches.push({ id: el.id, kind: "line", at: boxOf(el), points: 2 });
      }
    } else if (el.type === "text" && !boundText.has(el.id)) {
      const value = typeof el.text === "string" ? el.text.trim() : "";
      if (value) {
        texts.push({ id: el.id, text: value, at: [r(el.x), r(el.y)] });
      } else {
        omitted.emptyText = (omitted.emptyText ?? 0) + 1;
      }
    } else if (el.type === "freedraw") {
      const sketch: OutlineSketch = {
        id: el.id,
        kind: "path",
        at: boxOf(el),
        points: Array.isArray(el.points) ? el.points.length : 0,
      };
      if (tags) {
        sketch.tags = tags;
      }
      sketches.push(sketch);
    } else if (!boundText.has(el.id)) {
      omitted[el.type] = (omitted[el.type] ?? 0) + 1;
    }
  }

  // containment: the smallest node that fully encloses each thing
  const enclose = (box: [number, number, number, number], selfId?: string) => {
    let best: OutlineNode | null = null;
    for (const node of nodes) {
      if (node.id === selfId || !contains(node.at, box)) {
        continue;
      }
      if (!best || area(node.at) < area(best.at)) {
        best = node;
      }
    }
    return best?.id;
  };
  for (const node of nodes) {
    const owner = enclose(node.at, node.id);
    if (owner) {
      node.in = owner;
    }
  }
  for (const text of texts) {
    const owner = enclose([text.at[0], text.at[1], 1, 1]);
    if (owner) {
      text.in = owner;
    }
  }

  const boxes = [...nodes.map((n) => n.at), ...sketches.map((s) => s.at)];
  let bbox: SceneOutline["bbox"] = null;
  if (boxes.length) {
    const x0 = Math.min(...boxes.map((b) => b[0]));
    const y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
    const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    bbox = [r(x0), r(y0), r(x1 - x0), r(y1 - y0)];
  }

  const clusters = cluster([
    ...nodes.map((n) => ({ at: n.at, label: n.text ?? "" })),
    ...sketches.map((s) => ({ at: s.at, label: "" })),
  ]);

  const outline: SceneOutline = {
    name,
    bbox,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      texts: texts.length,
      sketches: sketches.length,
    },
    clusters,
    nodes: readingOrder(nodes),
    edges,
    texts: readingOrder(texts.map((t) => ({ ...t, at: t.at as any }))) as OutlineText[],
    sketches: readingOrder(sketches),
  };
  if (region) {
    outline.region = region.map(r) as Region;
    outline.outsideRegion = all.length - live.length;
  }
  if (Object.keys(omitted).length) {
    outline.omitted = omitted;
  }
  return outline;
};

/** Only the orientation block — the cheapest possible "what is this?". */
export const toSummary = (
  elements: readonly AnyElement[],
  name = "Untitled",
  region?: Region,
): Omit<SceneOutline, "nodes" | "edges" | "texts" | "sketches"> => {
  const { nodes, edges, texts, sketches, ...rest } = toOutline(
    elements,
    name,
    region,
  );
  return rest;
};
