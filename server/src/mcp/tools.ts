/**
 * MCP tool definitions. Thin wrappers over the scene store — the same code the
 * HTTP API uses — so a bot works with scenes through the compact semantic JSON
 * (see `../derive/semantic.ts`), never raw elements.
 */

import fs from "node:fs";

import { getActiveScene } from "../events.ts";
import { status as indexStatus } from "../index-queue.ts";
import {
  buildTemplate,
  listTemplates,
  UnknownTemplateError,
} from "../derive/templates.ts";
import { generateSemanticFromPrompt } from "../generate.ts";
import { thumbFile } from "../paths.ts";
import { renderScenePng } from "../render/browser.ts";
import { searchScenes } from "../search/index.ts";
import {
  addMessage,
  CommentNotFoundError,
  listComments,
  resolveComment,
} from "../store/comments.ts";
import {
  annotate,
  describeScene,
  getTag,
  linksFrom,
  linksTo,
  listTags,
  neighbours as graphNeighbours,
  stats as graphStats,
} from "../store/graph.ts";
import {
  SceneNotFoundError,
  appendSemantic,
  createScene,
  getMarkdown,
  getMermaid,
  getOutline,
  getOutlineSummary,
  getSceneContent,
  getSceneSummary,
  getSemantic,
  linkScene,
  listAnchors,
  listScenes,
  saveSceneFromSemantic,
  setElementAnchor,
  setElementTags,
  softDeleteScene,
  updateSceneMeta,
} from "../store/scenes.ts";

export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => McpToolResult | Promise<McpToolResult>;
}

const text = (value: unknown): McpToolResult => ({
  content: [
    {
      type: "text",
      text:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const fail = (message: string): McpToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Resolve a scene id argument. `"active"` (or omitted) means the scene the
 * editor currently has open, so a bot can edit alongside the user.
 */
const resolveId = (raw: unknown): string | null => {
  if (typeof raw === "string" && raw && raw !== "active") {
    return raw;
  }
  return getActiveScene()?.id ?? null;
};

const ID_PROP = {
  type: "string",
  description:
    "Scene id, or 'active' (the default) for whatever the editor has open.",
} as const;

const SEMANTIC_SCHEMA = {
  type: "object",
  description:
    "Compact scene graph. Nodes are boxes/ellipses/diamonds (optionally " +
    "labeled), edges connect nodes by id, texts are free labels, sketches " +
    "are freehand strokes (kind 'path' with points, or 'line' with " +
    "from/to). Positions (x,y,w,h) are optional — omitted nodes are laid " +
    "out on a grid.",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          shape: { enum: ["rectangle", "ellipse", "diamond"] },
          text: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
          color: { type: "string" },
          bg: { type: "string" },
          sticky: { type: "boolean" },
        },
        required: ["id", "shape"],
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          text: { type: "string" },
          style: { enum: ["arrow", "line"] },
          dashed: { type: "boolean" },
        },
        required: ["id", "from", "to"],
      },
    },
    texts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["id", "text"],
      },
    },
    sketches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { enum: ["path", "line"] },
          points: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
          },
          from: { type: "array", items: { type: "number" } },
          to: { type: "array", items: { type: "number" } },
          color: { type: "string" },
        },
        required: ["id", "kind"],
      },
    },
  },
} as const;

export const TOOLS: McpTool[] = [
  {
    name: "list_scenes",
    description:
      "List every saved drawing with its id, title, description, category, " +
      "item count and last-updated time.",
    inputSchema: { type: "object", properties: {} },
    handler: () =>
      text(
        listScenes().map((scene) => ({
          id: scene.id,
          name: scene.name,
          description: scene.description,
          category: scene.category,
          elementCount: scene.elementCount,
          updatedAt: scene.updatedAt,
        })),
      ),
  },
  {
    name: "search_scenes",
    description:
      "Find drawings by meaning, not just exact words — full-text over " +
      "title/description/category/contents, blended with embedding " +
      "similarity when available.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { enum: ["fts", "vector", "hybrid"] },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const hits = await searchScenes(
        String(args.query ?? ""),
        (args.mode as "fts" | "vector" | "hybrid") ?? "hybrid",
      );
      return text(hits);
    },
  },
  {
    name: "get_active_scene",
    description:
      "The drawing the editor currently has open (so you can edit alongside " +
      "the user). Returns its id and semantic graph, or nothing if the " +
      "dashboard is showing.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const active = getActiveScene();
      if (!active) {
        return text({ open: false });
      }
      return text({
        open: true,
        id: active.id,
        scene: getSemantic(active.id),
      });
    },
  },
  {
    name: "get_scene",
    description:
      "Read a drawing. Default format 'semantic' returns the compact scene " +
      "graph; 'markdown' a readable outline; 'mermaid' a flowchart (only for " +
      "a graph-shaped scene); 'excalidraw' the raw element list.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        format: { enum: ["semantic", "markdown", "mermaid", "excalidraw"] },
      },
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id || !getSceneSummary(id)) {
        return fail(id ? `No scene with id ${id}` : "No scene is open.");
      }
      if (args.format === "markdown") {
        return text(getMarkdown(id) ?? "");
      }
      if (args.format === "mermaid") {
        const mermaid = getMermaid(id);
        return mermaid
          ? text(mermaid)
          : fail("scene has no nodes/edges to diagram");
      }
      if (args.format === "excalidraw") {
        return text(getSceneContent(id) ?? {});
      }
      return text(getSemantic(id) ?? {});
    },
  },
  {
    name: "create_scene",
    description:
      "Create a new drawing. Pass a `semantic` graph to populate it, or omit " +
      "it for an empty canvas. Set `temporary: true` for a scratch drawing " +
      "that auto-deletes when idle 15 min / after 1 hour. Returns the id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        temporary: { type: "boolean" },
        semantic: SEMANTIC_SCHEMA,
      },
    },
    handler: (args) => {
      let scene = createScene({
        name: args.name,
        description: args.description,
        category: args.category,
        temporary: args.temporary === true,
      });
      if (args.semantic) {
        scene = saveSceneFromSemantic(scene.id, args.semantic).summary;
      }
      return text({ id: scene.id, name: scene.name, url: `/d/${scene.id}` });
    },
  },
  {
    name: "update_scene",
    description:
      "Replace a drawing's entire content with a semantic graph. If the " +
      "editor has it open, the change appears live.",
    inputSchema: {
      type: "object",
      properties: { id: ID_PROP, semantic: SEMANTIC_SCHEMA },
      required: ["semantic"],
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      try {
        const { version } = saveSceneFromSemantic(id, args.semantic);
        return text({ ok: true, id, version });
      } catch (error) {
        return fail(
          error instanceof SceneNotFoundError
            ? error.message
            : String(error),
        );
      }
    },
  },
  {
    name: "append_to_scene",
    description:
      "Add nodes/edges/texts/sketches to a drawing, keeping what's already " +
      "there. New node ids must not collide with existing ones. If the " +
      "editor has it open, the change appears live.",
    inputSchema: {
      type: "object",
      properties: { id: ID_PROP, semantic: SEMANTIC_SCHEMA },
      required: ["semantic"],
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      try {
        const { version } = appendSemantic(id, args.semantic);
        return text({ ok: true, id, version });
      } catch (error) {
        return fail(
          error instanceof SceneNotFoundError
            ? error.message
            : String(error),
        );
      }
    },
  },
  {
    name: "set_scene_meta",
    description:
      "Update title, description, category, folder or tags. category and folder are slash-separated and nest; tags is recorded as the user's, not yours.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        name: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        folder: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      try {
        const scene = updateSceneMeta(id, {
          name: args.name,
          description: args.description,
          category: args.category,
          folder: args.folder,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        });
        return text({
          id: scene.id,
          name: scene.name,
          description: scene.description,
          category: scene.category,
          folder: scene.folder,
          tags: scene.tags,
        });
      } catch (error) {
        return fail(
          error instanceof SceneNotFoundError
            ? error.message
            : String(error),
        );
      }
    },
  },
  {
    name: "delete_scene",
    description: "Move a drawing to the trash (soft delete).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: (args) =>
      softDeleteScene(String(args.id))
        ? text({ ok: true })
        : fail(`No scene with id ${args.id}`),
  },
  {
    name: "get_scene_image",
    description:
      "Get a PNG of the drawing — the client-rendered preview if one exists " +
      "(from being opened in the editor), otherwise a fresh server-side " +
      "render. Pass `anchor` to crop to one named element.",
    inputSchema: {
      type: "object",
      properties: { id: ID_PROP, anchor: { type: "string" } },
    },
    handler: async (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      if (!args.anchor) {
        const file = thumbFile(id);
        if (fs.existsSync(file)) {
          return {
            content: [
              {
                type: "image",
                data: fs.readFileSync(file).toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        }
      }
      try {
        const png = await renderScenePng(id, { anchor: args.anchor });
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (error) {
        return fail(`No preview available: ${(error as Error).message}`);
      }
    },
  },
  {
    name: "set_anchor",
    description:
      "Tag one element with a stable name, so it can be deep-linked or " +
      "cropped to later (get_scene_image with `anchor`). Pass `anchor: null` " +
      "to remove the tag. `elementId` is the node/edge/text id from the " +
      "semantic graph.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        elementId: { type: "string" },
        anchor: { type: ["string", "null"] },
      },
      required: ["elementId"],
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      try {
        const ok = setElementAnchor(id, String(args.elementId), args.anchor ?? null);
        return ok ? text({ ok: true }) : fail(`No element ${args.elementId}`);
      } catch (error) {
        return fail(
          error instanceof SceneNotFoundError ? error.message : String(error),
        );
      }
    },
  },
  {
    name: "list_anchors",
    description: "List every named anchor in a drawing and which element it tags.",
    inputSchema: { type: "object", properties: { id: ID_PROP } },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      return text(listAnchors(id));
    },
  },
  {
    name: "list_comments",
    description:
      "Region notes a person left on a drawing, each with the box it points at and its messages. Check before editing.",
    inputSchema: { type: "object", properties: { id: ID_PROP } },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      try {
        return text(listComments(id));
      } catch (error) {
        return fail(
          error instanceof SceneNotFoundError ? error.message : String(error),
        );
      }
    },
  },
  {
    name: "reply_to_comment",
    description:
      "Reply on a comment thread. Supports `code`, **bold**, *italic*, ==highlight==, ~~strike~~, - bullets, 1. numbers.",
    inputSchema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
        text: { type: "string" },
      },
      required: ["commentId", "text"],
    },
    handler: (args) => {
      try {
        const comment = addMessage(
          String(args.commentId),
          String(args.text),
          "agent",
        );
        return text(comment);
      } catch (error) {
        return fail(
          error instanceof CommentNotFoundError
            ? error.message
            : String(error),
        );
      }
    },
  },
  {
    name: "resolve_comment",
    description:
      "Mark a thread resolved. This deletes it.",
    inputSchema: {
      type: "object",
      properties: { commentId: { type: "string" } },
      required: ["commentId"],
    },
    handler: (args) => {
      const ok = resolveComment(String(args.commentId));
      return ok ? text({ ok: true }) : fail(`No comment ${args.commentId}`);
    },
  },
  {
    name: "generate_diagram",
    description:
      "Ask the local model (Ollama) to turn a short prompt into a diagram " +
      "and create it as a new drawing. Requires Ollama running locally with " +
      "OLLAMA_GENERATE_MODEL installed; otherwise build the semantic graph " +
      "yourself and use create_scene.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        name: { type: "string" },
      },
      required: ["prompt"],
    },
    handler: async (args) => {
      const result = await generateSemanticFromPrompt(String(args.prompt));
      if ("error" in result) {
        return fail(result.error);
      }
      const scene = createScene({
        name: args.name || String(args.prompt).slice(0, 60),
      });
      saveSceneFromSemantic(scene.id, result.scene);
      return text({ id: scene.id, name: scene.name, url: `/d/${scene.id}` });
    },
  },
  {
    name: "list_templates",
    description:
      "Ready-made diagram layouts and what each one takes. Use one instead of inventing coordinates.",
    inputSchema: { type: "object", properties: {} },
    handler: () => text(listTemplates()),
  },
  {
    name: "apply_template",
    description:
      "Build a diagram from a template and save it. mode: \"new\" (creates, returns an id), \"replace\", \"append\". Template fields go in spec — list_templates ships a working example for each, so copy that shape rather than guessing. On \"new\" you can file it straight away with category, folder and tags.",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string" },
        spec: { type: "object" },
        mode: { type: "string", enum: ["new", "replace", "append"] },
        id: ID_PROP,
        name: { type: "string" },
        category: { type: "string" },
        folder: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["template", "spec"],
    },
    handler: (args) => {
      let scene;
      try {
        scene = buildTemplate(
          String(args.template),
          (args.spec ?? {}) as Record<string, unknown>,
        );
      } catch (error) {
        return fail(
          error instanceof UnknownTemplateError
            ? error.message
            : String(error),
        );
      }
      if (!scene.nodes.length) {
        return fail(
          `The ${args.template} template produced nothing — check spec against list_templates.`,
        );
      }

      const mode = args.mode ?? "new";
      if (mode === "new") {
        const created = createScene({
          name: String(args.name || scene.name || "Untitled"),
          category: args.category ? String(args.category) : undefined,
          folder: args.folder ? String(args.folder) : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        });
        saveSceneFromSemantic(created.id, scene);
        return text({
          id: created.id,
          name: created.name,
          url: `/d/${created.id}`,
          nodes: scene.nodes.length,
        });
      }

      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open — pass id, or use mode \"new\".");
      }
      const result =
        mode === "append"
          ? appendSemantic(id, scene)
          : saveSceneFromSemantic(id, scene);
      return text({ id, mode, version: result.version, nodes: scene.nodes.length });
    },
  },
  {
    name: "get_scene_outline",
    description:
      "What is on a drawing and where, with real element ids, WITHOUT geometry: strokes become a bbox plus a point count. summary:true gives just name, extent, counts and clusters; bbox [x,y,w,h] limits it to one region — use it with a comment's region to answer \"what is inside that box\". Read with this; write with get_scene.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        summary: { type: "boolean" },
        bbox: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
        },
      },
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      const raw = args.bbox;
      let region;
      if (Array.isArray(raw)) {
        if (raw.length !== 4 || raw.some((n) => !Number.isFinite(Number(n)))) {
          return fail("bbox must be [x, y, width, height].");
        }
        region = raw.map(Number) as [number, number, number, number];
      }
      const result = args.summary
        ? getOutlineSummary(id, region)
        : getOutline(id, region);
      return result ? text(result) : fail("No such drawing.");
    },
  },
  {
    name: "describe_scene",
    description:
      "Everything the graph knows about one drawing — folder, category, tags (each marked person or agent), tagged boxes, links both ways — without opening it.",
    inputSchema: { type: "object", properties: { id: ID_PROP } },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      const facts = describeScene(id);
      return facts ? text(facts) : fail("The graph has not seen that drawing.");
    },
  },
  {
    name: "annotate_scene",
    description:
      "Record what looking at the image told you: extra tags and a one-line note. Marked as yours, survives saves and rebuilds, clearable in one call.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
      },
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      return text(
        annotate(id, {
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          note: typeof args.note === "string" ? args.note : undefined,
        }),
      );
    },
  },
  {
    name: "list_tags",
    description:
      "Every tag, with how many whole drawings and how many individual boxes carry it.",
    inputSchema: { type: "object", properties: {} },
    handler: () => text(listTags()),
  },
  {
    name: "get_tag",
    description:
      "The drawings and the individual boxes carrying one tag, each with the ids needed to act on it.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
    },
    handler: (args) => text(getTag(String(args.tag))),
  },
  {
    name: "tag_element",
    description:
      "Set the tags on ONE element, so the tag points at that box rather than the whole file. The list replaces; [] clears.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        elementId: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["elementId", "tags"],
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      const result = setElementTags(
        id,
        String(args.elementId),
        Array.isArray(args.tags) ? (args.tags as string[]) : [],
      );
      return result ? text(result) : fail("No such element in that drawing.");
    },
  },
  {
    name: "link_drawings",
    description:
      "Point one drawing at another. render \"embed\" (read-only block) or \"title\". The target is never edited through the link.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        targetSceneId: { type: "string" },
        render: { type: "string", enum: ["embed", "title"] },
      },
      required: ["targetSceneId"],
    },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      const result = linkScene(
        id,
        String(args.targetSceneId),
        args.render === "title" ? "title" : "embed",
      );
      return result ? text(result) : fail("Scene or target not found.");
    },
  },
  {
    name: "links",
    description:
      "The drawings this one points at, and the ones pointing back.",
    inputSchema: { type: "object", properties: { id: ID_PROP } },
    handler: (args) => {
      const id = resolveId(args.id);
      if (!id) {
        return fail("No scene is open.");
      }
      return text({ out: linksFrom(id), in: linksTo(id) });
    },
  },
  {
    name: "neighbours",
    description:
      "Walk outward from a node (\"tag:x\", \"scene:id\", \"box:scene/element\") and report what you reach — context without opening anything.",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string" },
        scene: { type: "string" },
        tag: { type: "string" },
        hops: { type: "number" },
      },
    },
    handler: (args) => {
      const start =
        (args.node && String(args.node)) ||
        (args.scene && `scene:${String(args.scene)}`) ||
        (args.tag && `tag:${String(args.tag)}`) ||
        null;
      if (!start) {
        return fail("Pass one of node, scene or tag.");
      }
      const hops = Math.min(4, Math.max(1, Number(args.hops) || 1));
      return text({ start, hops, neighbours: graphNeighbours(start, hops) });
    },
  },
  {
    name: "index_status",
    description:
      "What the background indexer is still working through. A save returns before search catches up, so check this if a just-saved drawing has not shown up in results yet.",
    inputSchema: { type: "object", properties: {} },
    handler: () => text(indexStatus()),
  },
  {
    name: "graph_stats",
    description:
      "Node and edge counts by kind.",
    inputSchema: { type: "object", properties: {} },
    handler: () => text(graphStats()),
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
