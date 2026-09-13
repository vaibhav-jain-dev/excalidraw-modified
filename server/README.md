# excalidraw-local-server

Local-first storage, rendering, search and MCP server for this Excalidraw fork.
See [`../LOCAL_FIRST_PLAN.md`](../LOCAL_FIRST_PLAN.md) for the full design and
roadmap.

## Status

All of steps 1–8 are in. Fastify server, SQLite metadata store (`node:sqlite`,
no native deps besides `sqlite-vec`), scene CRUD + version history (with a
dashboard history drawer — restore or pin any past version), title/description/
category, client-rendered PNG thumbnails, static hosting of the built app. The
app shows a **dashboard** for a bare URL and opens the editor at `/d/<id>`.

- **Semantic JSON** — every scene has a compact `{ nodes, edges, texts,
  sketches }` view (`scene.semantic.json`, `scene.md`, `scene.mmd`) that a bot
  can read and author; `fromSemantic` compiles it back to elements (grid
  layout when positions are omitted). Even a pencil stroke is a `sketch` here.
  Elements can carry a stable **named anchor** (`customData.anchor`) for
  deep-links and crop-to-element renders.
- **MCP** — `POST /mcp` (Streamable HTTP) and `yarn mcp` (stdio). Tools work
  through the semantic view and can target `"active"` — the scene the editor
  has open — so a bot edits alongside the user.
- **Live sync** — `GET /api/events` (SSE) broadcasts `scene-changed`; the
  editor picks up MCP / API / other-tab edits without a reload.
- **Routing** — a drawing opens at `/d/<id>` (bookmarkable, one per window);
  `#local=<id>` is rewritten to it.
- **Temporary scenes** — `temporary: true` on create makes a scratch drawing
  that a 60 s reaper hard-deletes once it's been idle 15 min (or 1 hour old).
- **Search** — SQLite FTS5 (built in, always on) blended with `sqlite-vec`
  embedding similarity (when Ollama can embed) via reciprocal rank fusion.
  Indexed the moment a scene is created — no need to save content first.
- **Server-side render** — a persistent headless Chromium drives the app's own
  `/d/<id>` page (dev server only — see below) to produce a PNG for a scene
  that was never opened in a browser, or a crop to one named anchor.
- **Text-to-diagram** — `POST /api/generate` / MCP `generate_diagram` asks a
  local Ollama model to turn a prompt straight into a new drawing.

Not yet: multi-window "active scene" is a single global slot (last one to
report presence wins) rather than per-window; auth (localhost-only by
design); Docker packaging.

## MCP

```bash
claude mcp add excalidraw-local -- node <repo>/server/src/mcp/stdio.ts
# or, against a running server:
claude mcp add --transport http excalidraw-local http://localhost:3057/mcp
```

Tools (29), by what they are for:

- **find** — `list_scenes`, `search_scenes`, `get_active_scene`, `list_tags`,
  `get_tag`, `neighbours`, `graph_stats`
- **read** — `describe_scene`, `get_scene_outline` (cheap, lossy, `bbox` for one
  region), `get_scene_image`, `get_scene`, `links`, `list_anchors`
- **add meaning** — `annotate_scene`, `tag_element`, `link_drawings`, `set_anchor`
- **draw** — `list_templates`, `apply_template` (23 layouts)
- **write** — `create_scene`, `update_scene`, `append_to_scene`, `set_scene_meta`,
  `delete_scene`, `generate_diagram`
- **review** — `list_comments`, `reply_to_comment`, `resolve_comment`
- **status** — `index_status`

Every client receives `AGENTS.md` as the MCP `instructions` on `initialize`, so
the guide and what an agent is told are the same bytes. See `SEMANTIC.md` for
which view to read and why.

## Requirements

- Node **>= 22** (Node **24+** recommended — runs the TypeScript sources
  directly with no build step and no experimental warnings).
- Optional, for embeddings / text-to-diagram: [Ollama](https://ollama.com)
  running locally, with an embedding model (`ollama pull nomic-embed-text`)
  and/or a chat model (`ollama pull llama3.2`) pulled. Everything else works
  fully without it — search just falls back to full-text only.
- Optional, for server-side rendering: a Chrome/Chromium binary (auto-detected
  at common install paths, or set `CHROME_PATH`).

## Running

```bash
# dev: server on :3057, Vite app on :3056 proxying /api here
yarn server:dev          # from repo root
yarn start               # separate terminal — the Excalidraw app

# or both at once
yarn dev:local

# production: server hosts the built app on one origin
yarn start:local         # = yarn build && yarn server  ->  http://localhost:3057
```

Server-side rendering needs `window.h` (a dev-only Vite hook), so it targets
`EXCALIDRAW_LOCAL_RENDER_ORIGIN` (default: this server's own origin) — point
it at your Vite dev server's URL if you're running the two separately.

## Configuration (env vars)

| Var                                | Default                   | Purpose                                    |
| ----------------------------------- | -------------------------- | ------------------------------------------- |
| `LOCAL_SERVER_PORT`                | `3057`                    | Listen port                                |
| `LOCAL_SERVER_HOST`                | `127.0.0.1`               | Listen host                                |
| `EXCALIDRAW_LOCAL_DATA_DIR`        | `~/.excalidraw-local`     | Root of all persisted data                 |
| `EXCALIDRAW_LOCAL_APP_DIR`         | `../excalidraw-app/build` | Built app to serve at `/`                  |
| `EXCALIDRAW_LOCAL_SERVE_APP`       | `true`                    | Set `false` to run API-only                |
| `EXCALIDRAW_LOCAL_MAX_VERSIONS`    | `30`                      | Non-pinned versions kept per scene         |
| `EXCALIDRAW_LOCAL_BODY_LIMIT`      | `50331648` (48 MiB)       | Max request body                           |
| `LOG_LEVEL`                        | `info`                    | Fastify/pino log level                     |
| `OLLAMA_HOST`                      | `http://localhost:11434`  | Ollama server for embeddings + generation  |
| `OLLAMA_EMBED_MODEL`               | `nomic-embed-text`        | Embedding model (must match `EXCALIDRAW_LOCAL_EMBED_DIM`) |
| `OLLAMA_GENERATE_MODEL`            | `llama3.2`                | Text-to-diagram model (use the exact tag `ollama list` shows, e.g. `llama3.2:3b`) |
| `EXCALIDRAW_LOCAL_EMBED_DIM`       | `768`                     | Vector dimension the embed model outputs   |
| `CHROME_PATH`                      | auto-detected             | Chrome/Chromium binary for server-side render |
| `EXCALIDRAW_LOCAL_RENDER_ORIGIN`   | this server's own origin  | Where the render browser navigates to (`/d/<id>`) |

## Data layout

```
~/.excalidraw-local/
  index.db                       SQLite: scenes, versions, FTS5, vec0, kv
  scenes/<id>/
    v0001.excalidraw             one lossless Excalidraw file per saved version
    v0002.excalidraw
    latest.excalidraw            mirror of the newest version
    scene.semantic.json          compact node/edge/text/sketch graph
    scene.md                     human-readable outline (also the FTS body)
    scene.mmd                    Mermaid flowchart (graph-shaped scenes only)
  thumbs/<id>.png                client-rendered on save
```

## API

| Method   | Path                                     | Notes                                       |
| -------- | ----------------------------------------- | -------------------------------------------- |
| `GET`    | `/api/health`                            | liveness                                     |
| `GET`    | `/api/scenes`                            | list summaries                               |
| `GET`    | `/api/categories`                        | distinct non-empty categories                |
| `POST`   | `/api/scenes`                            | `{ name?, description?, category?, tags?, temporary?, semantic? }` → `{ scene }` |
| `GET`    | `/api/scenes/:id`                        | `{ scene, elements, appState, files }`       |
| `PUT`    | `/api/scenes/:id`                        | save → new version                           |
| `PATCH`  | `/api/scenes/:id`                        | `{ name?, description?, category?, tags?, pinned? }` |
| `DELETE` | `/api/scenes/:id`                        | soft delete                                  |
| `GET`    | `/api/scenes/:id/versions`               | version list                                 |
| `GET`    | `/api/scenes/:id/versions/:version`      | full scene at version                        |
| `POST`   | `/api/scenes/:id/versions/:version/pin`  | `{ pinned? }` (default `true`)               |
| `PUT`    | `/api/scenes/:id/thumbnail`              | `image/png` body → stored preview            |
| `GET`    | `/api/scenes/:id/thumbnail`              | the PNG preview (404 if none)                |
| `GET`    | `/api/scenes/:id/render.png`             | fresh server-side render; `?anchor=&width=&height=` |
| `GET`    | `/api/scenes/:id/anchors`                | named anchors + bounds in this scene         |
| `PUT`    | `/api/scenes/:id/anchors/:elementId`     | `{ anchor: string \| null }`                  |
| `GET`    | `/api/scenes/:id/semantic`               | compact `{ nodes, edges, texts, sketches }`  |
| `PUT`    | `/api/scenes/:id/semantic`               | replace the scene from a semantic graph      |
| `POST`   | `/api/scenes/:id/semantic/append`        | merge a semantic fragment                    |
| `GET`    | `/api/scenes/:id/markdown`               | readable outline                             |
| `GET`    | `/api/scenes/:id/mermaid`                | Mermaid flowchart (422 if not graph-shaped)  |
| `POST`   | `/api/scenes/:id/presence`               | editor → "this scene is open"                |
| `GET`    | `/api/events`                            | SSE stream of `scene-changed`                |
| `GET`    | `/api/search?q=&mode=fts\|vector\|hybrid`  | ranked results, blended (default hybrid)     |
| `GET`    | `/api/search/status`                     | `{ vectorAvailable }`                        |
| `POST`   | `/api/generate`                          | `{ prompt, name? }` → new scene from Ollama  |
| `POST`   | `/mcp`                                   | Model Context Protocol (JSON-RPC)            |

## Type checking / tests

```bash
yarn test:typecheck:server   # from repo root  (tsc -p server/tsconfig.json)
yarn test:server             # node --test over server/src/**/*.test.ts
```

`server/` is currently excluded from the repo-wide ESLint pass
(`.eslintignore`); revisit once the shape settles.
