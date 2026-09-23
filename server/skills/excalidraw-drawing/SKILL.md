---
name: excalidraw-drawing
description: The local-first Excalidraw fork — a library of drawings with folders, categories, tags, links, version history, search and 23 layout templates, driven through its own MCP server. Use it to draw or read a flow, architecture, sequence, state or data-model diagram. Author only through its MCP tools, never by writing .excalidraw JSON by hand; its authoring rules and tool catalogue come from the running server, so connect before drawing.
license: MIT
metadata:
  author: excalidraw-modified
  version: "1"
  produces: "*.excalidraw"
  links: "tech:excalidraw, tech:mcp, concept:diagrams"
  mcp-url: http://localhost:3057/mcp
  mcp-command: node server/src/mcp/stdio.ts
---

# Excalidraw drawing library

A fork of Excalidraw with a local-first server beside it (`server/`): every
drawing has a folder, one category, tags, links to other drawings and a
version history, all kept in SQLite under `~/.excalidraw-local`. The server
serves the editor, a JSON API, live sync, search and an MCP server that an
agent draws and reads through.

## Run it

From the repository root:

```sh
yarn install
yarn build          # once: the editor the server serves at /
yarn server         # http://127.0.0.1:3057 — API, MCP and the built app
```

`GET /api/health` answers `{ok: true}` when it is the right server. `make run`
starts the **Vite dev server on :3056** for editor development — it serves no
`/api` and no `/mcp`, so an agent must not point at it. `yarn server:dev`
restarts the server on change.

Environment: `LOCAL_SERVER_PORT` (3057), `EXCALIDRAW_LOCAL_DATA_DIR`
(`~/.excalidraw-local`), `OLLAMA_HOST` for search embeddings and text-to-
diagram (optional; search still works on full text without it), `CHROME_PATH`
for server-side PNG rendering.

## Connect

```sh
claude mcp add --transport http excalidraw-local http://localhost:3057/mcp
# or, over stdio, sharing the same data directory:
claude mcp add excalidraw-local -- node server/src/mcp/stdio.ts
```

## The rules come from the server, not from this file

`initialize` returns `server/AGENTS.md` — the rules, the cost ladder and
which tool to reach for — and `tools/list` the catalogue. Read those live;
they change with the server and this file does not. The two rules worth
knowing before you connect:

- **Never write `.excalidraw` JSON by hand.** It is a storage format: a
  labelled box is two elements joined by an id, an arrow only means "depends
  on" when both bindings resolve. Hand-written geometry produces overlapping
  boxes and arrows that connect nothing. `list_templates` then
  `apply_template` solves the layout; write raw coordinates only when no
  template fits, and say so.
- **Every id comes from a tool result.** Scene ids, element ids and tags are
  never constructed.

## Reading, cheapest first

`describe_scene` (graph only, ~20 tokens) → `get_scene_outline {summary:
true}` (~75) → `get_scene_outline` (~190) → `get_scene_image` (~1 100, the
only view that shows what a sketch depicts) → `get_scene` (thousands; only to
write). `server/SEMANTIC.md` measures the four views against a real drawing
and explains why the outline is lossy on purpose.

## With Project Weaver

Weaver mirrors each drawing's mermaid, outline and summary so agents read the
shape of a system without this server running. Its conventions — link every
diagram to what it explains, sync after drawing — and this server's live
rules come together from `weaver_diagram_guide`; call that first when working
inside Weaver.
