/**
 * MCP tool definitions. Thin wrappers over the scene store — the same code the
 * HTTP API uses — so a bot works with scenes through the compact semantic JSON
 * (see `../derive/semantic.ts`), never raw elements.
 */

import fs from "node:fs";

import { getActiveScene } from "../events.ts";
import { generateSemanticFromPrompt } from "../generate.ts";
import { thumbFile } from "../paths.ts";
import { renderScenePng } from "../render/browser.ts";
import { searchScenes } from "../search/index.ts";
import {
  appendSemantic,
  createScene,
  getMarkdown,
  getMermaid,
  getSceneContent,
  getSceneSummary,
  getSemantic,
  listAnchors,
  listScenes,
  saveSceneFromSemantic,
  SceneNotFoundError,
  setElementAnchor,
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
    description: "Update a drawing's title, description or category.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        name: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
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
        });
        return text({
          id: scene.id,
          name: scene.name,
          description: scene.description,
          category: scene.category,
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
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
