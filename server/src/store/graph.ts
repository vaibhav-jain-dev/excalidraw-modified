import fs from "node:fs";
import path from "node:path";

import { config } from "../config.ts";
import { ensureDir } from "../paths.ts";

/**
 * The tag / link graph.
 *
 * Deliberately NOT in SQLite. It is small, read on almost every request,
 * walked in every direction, and grows new edge kinds as the product does —
 * all of which a recursive CTE and a migration per edge kind serve badly.
 * It is held in memory and persisted as one JSON file a human (or an agent)
 * can read.
 *
 * It is also entirely DERIVED: every edge can be recomputed from the scenes
 * themselves (`customData.tags` on an element, `customData.link` for a
 * drawing-to-drawing reference, the `tags` column for scene-level tags). So a
 * lost or corrupt `graph.json` costs a `rebuild()`, never data. That is the
 * whole reason to keep it cheap and rewritable.
 *
 *   node ids:  "tag:<name>" | "scene:<sceneId>" | "box:<sceneId>/<elementId>"
 */

export type GraphNodeKind = "tag" | "scene" | "box" | "category" | "folder";
export type GraphEdgeKind =
  | "tagged"
  | "tagged-part"
  | "links-to"
  /** scene -> one of its own tagged boxes, so a walk can descend into a drawing */
  | "contains"
  /** scene -> the category it is filed under (leaf of the category chain) */
  | "filed-under"
  /** scene -> the folder it lives in (leaf of the folder chain) */
  | "lives-in"
  /** category -> parent category, folder -> parent folder */
  | "child-of";

/**
 * Who put an edge there. Everything derived from a drawing is "scene" and is
 * rewritten wholesale on every save. An LLM that has looked at the rendered
 * image and added its own tags writes "agent" edges, which survive that
 * rewrite — otherwise the next save would erase them.
 */
export type GraphEdgeSource = "scene" | "agent";

export interface GraphNode {
  kind: GraphNodeKind;
  /** display text: the tag name, the scene name, the box's label */
  label: string;
  /** for a box: the scene it lives in */
  scene?: string;
  /** for a category or folder: its full slash-separated path */
  path?: string;
  /** for a scene: what an LLM said about the image after looking at it */
  note?: string;
  created: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** links-to only: how the reference is drawn in the host scene */
  render?: "embed" | "title";
  /** omitted means "scene" — the common case, so it stays out of the file */
  by?: GraphEdgeSource;
}

interface GraphFile {
  version: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

const FILE_VERSION = 1;

export const graphFile = (): string => path.join(config.dataDir, "graph.json");

export const tagNode = (name: string): string => `tag:${normalizeTag(name)}`;
export const sceneNode = (sceneId: string): string => `scene:${sceneId}`;
export const boxNode = (sceneId: string, elementId: string): string =>
  `box:${sceneId}/${elementId}`;
export const pathNode = (kind: "category" | "folder", path: string): string =>
  `${kind}:${path.toLowerCase()}`;

/** Tags are case- and space-insensitive so "Broken Code" and "broken-code" are one node. */
export const normalizeTag = (raw: string): string =>
  String(raw).trim().toLowerCase().replace(/\s+/g, "-").replace(/^#/, "");

let graph: GraphFile = { version: FILE_VERSION, nodes: {}, edges: [] };
let loaded = false;
let flushTimer: NodeJS.Timeout | null = null;

const now = (): string => new Date().toISOString();

export const load = (): void => {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = fs.readFileSync(graphFile(), "utf8");
    const parsed = JSON.parse(raw) as GraphFile;
    if (parsed && typeof parsed === "object" && parsed.nodes && parsed.edges) {
      graph = {
        version: FILE_VERSION,
        nodes: parsed.nodes,
        edges: parsed.edges.filter((e) => e && e.from && e.to && e.kind),
      };
    }
  } catch {
    // no file yet, or an unreadable one — start empty; rebuild() restores it
  }
};

/** Write the graph out. Debounced: a burst of saves costs one write. */
export const flush = (immediate = false): void => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const write = () => {
    ensureDir(config.dataDir);
    const tmp = `${graphFile()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`);
    fs.renameSync(tmp, graphFile());
  };
  if (immediate) {
    write();
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      write();
    } catch (error) {
      console.warn("could not persist graph.json:", error);
    }
  }, 250);
  flushTimer.unref?.();
};

// ---------------------------------------------------------------------------
// mutation
// ---------------------------------------------------------------------------

const ensureNode = (id: string, node: Omit<GraphNode, "created">): void => {
  load();
  const existing = graph.nodes[id];
  if (existing) {
    // keep the original creation time; labels can drift as things are renamed
    graph.nodes[id] = { ...existing, ...node };
  } else {
    graph.nodes[id] = { ...node, created: now() };
  }
};

const dropEdges = (
  predicate: (edge: GraphEdge) => boolean,
): number => {
  const before = graph.edges.length;
  graph.edges = graph.edges.filter((edge) => !predicate(edge));
  return before - graph.edges.length;
};

const addEdge = (edge: GraphEdge): void => {
  const dupe = graph.edges.some(
    (e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
  );
  if (!dupe) {
    graph.edges.push(edge);
  }
};

/**
 * Turn "Architecture/Storage/Graph store" into a chain of nodes, each a child
 * of the one above, and hand back the leaf. Nesting comes for free from the
 * path, so categories and folders go as deep as someone types.
 */
const pathChain = (kind: "category" | "folder", raw: string): string | null => {
  const parts = String(raw || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }
  let acc = "";
  let parent: string | null = null;
  let leaf: string | null = null;
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const id = pathNode(kind, acc);
    ensureNode(id, { kind, label: part, path: acc });
    if (parent) {
      addEdge({ from: id, to: parent, kind: "child-of" });
    }
    parent = id;
    leaf = id;
  }
  return leaf;
};

/**
 * Drop every node that no edge references any more. Tags exist only as long
 * as something is tagged with them — there is no separate tag registry to
 * fall out of sync.
 */
const collectGarbage = (): void => {
  const used = new Set<string>();
  for (const edge of graph.edges) {
    used.add(edge.from);
    used.add(edge.to);
  }
  for (const id of Object.keys(graph.nodes)) {
    if (!used.has(id)) {
      delete graph.nodes[id];
    }
  }
};

type AnyElement = Record<string, any>;

const readTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string") {
      const tag = normalizeTag(entry);
      if (tag) {
        seen.add(tag);
      }
    }
  }
  return [...seen];
};

const elementLabel = (element: AnyElement, byContainer: Map<string, string>): string => {
  const own = typeof element.text === "string" ? element.text.trim() : "";
  return own || byContainer.get(element.id) || element.type || "box";
};

/**
 * Re-derive every edge owned by one scene from that scene's own content.
 * Called on save, so the graph can never drift from the drawings.
 */
export interface SceneFacts {
  id: string;
  name: string;
  tags: readonly string[];
  /** slash-separated, nests as deep as it is typed */
  category?: string;
  folder?: string;
}

export const reconcileScene = (
  scene: SceneFacts,
  elements: readonly AnyElement[],
): void => {
  load();
  const sceneId = scene.id;
  const live = elements.filter((el) => el && !el.isDeleted);
  const sid = sceneNode(sceneId);

  // everything this scene DERIVES goes; we are about to rewrite it. Agent
  // annotations are not derived, so they stay.
  dropEdges(
    (edge) =>
      edge.by !== "agent" &&
      (edge.from === sid ||
        edge.from.startsWith(`box:${sceneId}/`) ||
        edge.to.startsWith(`box:${sceneId}/`)),
  );

  ensureNode(sid, { kind: "scene", label: scene.name || "Untitled" });

  const category = pathChain("category", scene.category ?? "");
  if (category) {
    addEdge({ from: sid, to: category, kind: "filed-under" });
  }
  const folder = pathChain("folder", scene.folder ?? "");
  if (folder) {
    addEdge({ from: sid, to: folder, kind: "lives-in" });
  }

  for (const tag of readTags(scene.tags)) {
    ensureNode(tagNode(tag), { kind: "tag", label: tag });
    addEdge({ from: sid, to: tagNode(tag), kind: "tagged" });
  }

  const labelByContainer = new Map<string, string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId && typeof el.text === "string") {
      labelByContainer.set(el.containerId, el.text.trim());
    }
  }

  for (const el of live) {
    const custom = (el.customData ?? {}) as AnyElement;

    const tags = readTags(custom.tags);
    if (tags.length) {
      const bid = boxNode(sceneId, el.id);
      ensureNode(bid, {
        kind: "box",
        label: elementLabel(el, labelByContainer),
        scene: sceneId,
      });
      addEdge({ from: sid, to: bid, kind: "contains" });
      for (const tag of tags) {
        ensureNode(tagNode(tag), { kind: "tag", label: tag });
        addEdge({ from: bid, to: tagNode(tag), kind: "tagged-part" });
      }
    }

    // a reference to another drawing, drawn as an embedded block or a title chip
    const link = custom.link;
    if (link && typeof link === "object" && typeof link.sceneId === "string") {
      const target = sceneNode(link.sceneId);
      if (!graph.nodes[target]) {
        ensureNode(target, { kind: "scene", label: link.name ?? link.sceneId });
      }
      addEdge({
        from: sid,
        to: target,
        kind: "links-to",
        render: link.render === "title" ? "title" : "embed",
      });
    }
  }

  collectGarbage();
  flush();
};

/**
 * What an LLM adds after actually looking at the rendered image: extra tags,
 * and a short note about what the drawing shows. This is the point of the
 * graph — the drawing carries the shapes, the graph carries what they mean,
 * and some of that meaning is only visible to something that can see.
 *
 * Written as `by: "agent"` so it survives the next save's re-derive, and so a
 * reader can always tell a machine's opinion from a person's.
 */
export const annotate = (
  sceneId: string,
  annotation: { tags?: readonly string[]; note?: string },
): { tags: string[]; note?: string } => {
  load();
  const sid = sceneNode(sceneId);
  const existing = graph.nodes[sid];
  ensureNode(sid, {
    kind: "scene",
    label: existing?.label ?? sceneId,
    ...(existing?.path ? { path: existing.path } : {}),
  });

  if (typeof annotation.note === "string") {
    const note = annotation.note.trim();
    const node = graph.nodes[sid]!;
    if (note) {
      node.note = note;
    } else {
      delete node.note;
    }
  }

  const tags = readTags(annotation.tags ?? []);
  for (const tag of tags) {
    ensureNode(tagNode(tag), { kind: "tag", label: tag });
    addEdge({ from: sid, to: tagNode(tag), kind: "tagged", by: "agent" });
  }

  flush();
  return { tags, note: graph.nodes[sid]?.note };
};

/** Drop everything an agent added to one scene, keeping what it derived. */
export const clearAnnotations = (sceneId: string): number => {
  load();
  const sid = sceneNode(sceneId);
  const removed = dropEdges((edge) => edge.by === "agent" && edge.from === sid);
  const node = graph.nodes[sid];
  if (node) {
    delete node.note;
  }
  collectGarbage();
  flush();
  return removed;
};

/** Everything the graph knows about one drawing, in one read. */
export interface SceneGraphFacts {
  scene: string;
  name: string;
  note?: string;
  category: string | null;
  folder: string | null;
  tags: Array<{ tag: string; by: GraphEdgeSource }>;
  boxes: Array<{ elementId: string; label: string; tags: string[] }>;
  linksOut: Array<{ sceneId: string; name: string; render: "embed" | "title" }>;
  linksIn: Array<{ sceneId: string; name: string }>;
}

export const describeScene = (sceneId: string): SceneGraphFacts | null => {
  load();
  const sid = sceneNode(sceneId);
  const node = graph.nodes[sid];
  if (!node) {
    return null;
  }
  const out: SceneGraphFacts = {
    scene: sceneId,
    name: node.label,
    category: null,
    folder: null,
    tags: [],
    boxes: [],
    linksOut: linksFrom(sceneId),
    linksIn: linksTo(sceneId),
  };
  if (node.note) {
    out.note = node.note;
  }

  const boxes = new Map<string, { elementId: string; label: string; tags: string[] }>();
  for (const edge of graph.edges) {
    if (edge.from === sid && edge.kind === "tagged") {
      const tag = graph.nodes[edge.to];
      if (tag) {
        out.tags.push({ tag: tag.label, by: edge.by ?? "scene" });
      }
    } else if (edge.from === sid && edge.kind === "filed-under") {
      out.category = graph.nodes[edge.to]?.path ?? null;
    } else if (edge.from === sid && edge.kind === "lives-in") {
      out.folder = graph.nodes[edge.to]?.path ?? null;
    } else if (edge.from === sid && edge.kind === "contains") {
      const box = graph.nodes[edge.to];
      if (box) {
        boxes.set(edge.to, {
          elementId: edge.to.slice(`box:${sceneId}/`.length),
          label: box.label,
          tags: [],
        });
      }
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === "tagged-part" && boxes.has(edge.from)) {
      const tag = graph.nodes[edge.to];
      if (tag) {
        boxes.get(edge.from)!.tags.push(tag.label);
      }
    }
  }
  out.boxes = [...boxes.values()];
  return out;
};

/** Forget a scene entirely — used when one is hard-deleted. */
export const removeScene = (sceneId: string): void => {
  load();
  const sid = sceneNode(sceneId);
  dropEdges(
    (edge) =>
      edge.from === sid ||
      edge.to === sid ||
      edge.from.startsWith(`box:${sceneId}/`) ||
      edge.to.startsWith(`box:${sceneId}/`),
  );
  delete graph.nodes[sid];
  collectGarbage();
  flush();
};

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export interface TagSummary {
  tag: string;
  scenes: number;
  boxes: number;
}

export const listTags = (): TagSummary[] => {
  load();
  const counts = new Map<string, TagSummary>();
  for (const edge of graph.edges) {
    if (edge.kind !== "tagged" && edge.kind !== "tagged-part") {
      continue;
    }
    const node = graph.nodes[edge.to];
    if (!node || node.kind !== "tag") {
      continue;
    }
    const entry = counts.get(node.label) ?? { tag: node.label, scenes: 0, boxes: 0 };
    if (edge.kind === "tagged") {
      entry.scenes += 1;
    } else {
      entry.boxes += 1;
    }
    counts.set(node.label, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.scenes + b.boxes - (a.scenes + a.boxes) || a.tag.localeCompare(b.tag),
  );
};

export interface TagDetail {
  tag: string;
  scenes: Array<{ sceneId: string; name: string }>;
  boxes: Array<{ sceneId: string; elementId: string; label: string }>;
}

export const getTag = (name: string): TagDetail => {
  load();
  const tid = tagNode(name);
  const detail: TagDetail = { tag: normalizeTag(name), scenes: [], boxes: [] };
  for (const edge of graph.edges) {
    if (edge.to !== tid) {
      continue;
    }
    const node = graph.nodes[edge.from];
    if (!node) {
      continue;
    }
    if (edge.kind === "tagged" && node.kind === "scene") {
      detail.scenes.push({ sceneId: edge.from.slice("scene:".length), name: node.label });
    } else if (edge.kind === "tagged-part" && node.kind === "box") {
      const rest = edge.from.slice("box:".length);
      const slash = rest.indexOf("/");
      detail.boxes.push({
        sceneId: rest.slice(0, slash),
        elementId: rest.slice(slash + 1),
        label: node.label,
      });
    }
  }
  return detail;
};

export interface Neighbour {
  id: string;
  kind: GraphNodeKind;
  label: string;
  hops: number;
  via: GraphEdgeKind;
  by: GraphEdgeSource;
}

/**
 * Breadth-first walk from any node. This is the "what did I already work out
 * near this?" question, and the reason the graph is held in memory: it is
 * pointer-chasing, not a join.
 */
export const neighbours = (start: string, hops = 1, limit = 100): Neighbour[] => {
  load();
  if (!graph.nodes[start]) {
    return [];
  }
  const seen = new Set<string>([start]);
  const out: Neighbour[] = [];
  let frontier: Array<{ id: string; via: GraphEdgeKind }> = [
    { id: start, via: "tagged" },
  ];

  for (let depth = 1; depth <= Math.max(1, hops); depth += 1) {
    const next: Array<{ id: string; via: GraphEdgeKind }> = [];
    for (const { id } of frontier) {
      for (const edge of graph.edges) {
        const other =
          edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (!other || seen.has(other)) {
          continue;
        }
        const node = graph.nodes[other];
        if (!node) {
          continue;
        }
        seen.add(other);
        out.push({
          id: other,
          kind: node.kind,
          label: node.label,
          hops: depth,
          via: edge.kind,
          by: edge.by ?? "scene",
        });
        next.push({ id: other, via: edge.kind });
        if (out.length >= limit) {
          return out;
        }
      }
    }
    frontier = next;
    if (!frontier.length) {
      break;
    }
  }
  return out;
};

export interface GraphStats {
  nodes: number;
  edges: number;
  tags: number;
  scenes: number;
  boxes: number;
  categories: number;
  folders: number;
  /** edges an LLM added after looking at an image */
  annotated: number;
  byKind: Record<GraphEdgeKind, number>;
}

export const stats = (): GraphStats => {
  load();
  const byKind = {
    tagged: 0,
    "tagged-part": 0,
    "links-to": 0,
    contains: 0,
    "filed-under": 0,
    "lives-in": 0,
    "child-of": 0,
  } as Record<GraphEdgeKind, number>;
  for (const edge of graph.edges) {
    byKind[edge.kind] = (byKind[edge.kind] ?? 0) + 1;
  }
  const kinds = Object.values(graph.nodes);
  return {
    nodes: kinds.length,
    edges: graph.edges.length,
    tags: kinds.filter((n) => n.kind === "tag").length,
    scenes: kinds.filter((n) => n.kind === "scene").length,
    boxes: kinds.filter((n) => n.kind === "box").length,
    categories: kinds.filter((n) => n.kind === "category").length,
    folders: kinds.filter((n) => n.kind === "folder").length,
    annotated: graph.edges.filter((e) => e.by === "agent").length,
    byKind,
  };
};

/** Links out of one scene, with how each is rendered in the host drawing. */
export const linksFrom = (
  sceneId: string,
): Array<{ sceneId: string; name: string; render: "embed" | "title" }> => {
  load();
  const sid = sceneNode(sceneId);
  return graph.edges
    .filter((e) => e.kind === "links-to" && e.from === sid)
    .map((e) => ({
      sceneId: e.to.slice("scene:".length),
      name: graph.nodes[e.to]?.label ?? e.to,
      render: e.render === "title" ? "title" : "embed",
    }));
};

/** Scenes that reference this one — backlinks. */
export const linksTo = (
  sceneId: string,
): Array<{ sceneId: string; name: string }> => {
  load();
  const sid = sceneNode(sceneId);
  return graph.edges
    .filter((e) => e.kind === "links-to" && e.to === sid)
    .map((e) => ({
      sceneId: e.from.slice("scene:".length),
      name: graph.nodes[e.from]?.label ?? e.from,
    }));
};

/** The raw graph, for `rebuild` and for tests. */
export const snapshot = (): GraphFile => {
  load();
  return { version: graph.version, nodes: { ...graph.nodes }, edges: [...graph.edges] };
};

/** Drop everything in memory. Tests use this; a rebuild does not. */
export const reset = (): void => {
  load();
  graph = { version: FILE_VERSION, nodes: {}, edges: [] };
};

/**
 * Clear only what is derived from the drawings, keeping every agent
 * annotation and the notes attached to scenes. This is what a rebuild uses:
 * re-deriving must never throw away what a model worked out by looking at
 * the images, because nothing else in the system can reproduce it.
 */
export const resetDerived = (): void => {
  load();
  const keptEdges = graph.edges.filter((edge) => edge.by === "agent");
  const notes = new Map<string, string>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.kind === "scene" && node.note) {
      notes.set(id, node.note);
    }
  }
  const nodes: Record<string, GraphNode> = {};
  for (const edge of keptEdges) {
    for (const id of [edge.from, edge.to]) {
      if (graph.nodes[id]) {
        nodes[id] = graph.nodes[id]!;
      }
    }
  }
  for (const [id, note] of notes) {
    if (!nodes[id] && graph.nodes[id]) {
      nodes[id] = graph.nodes[id]!;
    }
    if (nodes[id]) {
      nodes[id]!.note = note;
    }
  }
  graph = { version: FILE_VERSION, nodes, edges: keptEdges };
};
