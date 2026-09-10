# excalidraw-local-server

Local-first storage, rendering, search and MCP server for this Excalidraw fork.
See [`../LOCAL_FIRST_PLAN.md`](../LOCAL_FIRST_PLAN.md) for the full design and
roadmap.

## Status

**Steps 1–4.** Fastify server, SQLite metadata store (`node:sqlite`, no native
deps), scene CRUD + version history, title/description/category, client-rendered
PNG thumbnails, static hosting of the built app. The app shows a **dashboard**
for a bare URL and opens the editor for `#local=<id>`.

- **Semantic JSON** — every scene has a compact `{ nodes, edges, texts,
  sketches }` view (`scene.semantic.json`, `scene.md`) that a bot can read and
  author; `fromSemantic` compiles it back to elements (grid layout when
  positions are omitted). Even a pencil stroke is a `sketch` here.
- **MCP** — `POST /mcp` (Streamable HTTP) and `yarn mcp` (stdio). Tools work
  through the semantic view and can target `"active"` — the scene the editor
  has open — so a bot edits alongside the user.
- **Live sync** — `GET /api/events` (SSE) broadcasts `scene-changed`; the
  editor picks up MCP / API / other-tab edits without a reload.

Not yet: server-side PNG rendering, full-text / vector search.

## MCP

```bash
claude mcp add excalidraw-local -- node <repo>/server/src/mcp/stdio.ts
# or, against a running server:
claude mcp add --transport http excalidraw-local http://localhost:3057/mcp
```

Tools: `list_scenes`, `search_scenes`, `get_active_scene`, `get_scene`,
`create_scene`, `update_scene`, `append_to_scene`, `set_scene_meta`,
`delete_scene`, `get_scene_image`.

## Requirements

- Node **>= 22** (Node **24+** recommended — runs the TypeScript sources
  directly with no build step and no experimental warnings).

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

## Configuration (env vars)

| Var                             | Default                   | Purpose                                  |
| ------------------------------- | ------------------------- | ---------------------------------------- |
| `LOCAL_SERVER_PORT`             | `3057`                    | Listen port                              |
| `LOCAL_SERVER_HOST`             | `127.0.0.1`               | Listen host                              |
| `EXCALIDRAW_LOCAL_DATA_DIR`     | `~/.excalidraw-local`     | Root of all persisted data               |
| `EXCALIDRAW_LOCAL_APP_DIR`      | `../excalidraw-app/build` | Built app to serve at `/`                |
| `EXCALIDRAW_LOCAL_SERVE_APP`    | `true`                    | Set `false` to run API-only              |
| `EXCALIDRAW_LOCAL_MAX_VERSIONS` | `30`                      | Non-pinned versions kept per scene       |
| `EXCALIDRAW_LOCAL_BODY_LIMIT`   | `50331648` (48 MiB)       | Max request body                         |
| `LOG_LEVEL`                     | `info`                    | Fastify/pino log level                   |

## Data layout

```
~/.excalidraw-local/
  index.db                       SQLite: scenes, scene_versions, schema_migrations
  scenes/<id>/
    v0001.excalidraw             one lossless Excalidraw file per saved version
    v0002.excalidraw
    latest.excalidraw            mirror of the newest version
  thumbs/<id>.png                (step 3)
  files/<fileId>.bin             (step 2)
```

## API

| Method   | Path                                  | Notes                              |
| -------- | ------------------------------------- | ---------------------------------- |
| `GET`    | `/api/health`                        | liveness                           |
| `GET`    | `/api/scenes`                        | list summaries                     |
| `GET`    | `/api/categories`                    | distinct non-empty categories      |
| `POST`   | `/api/scenes`                        | `{ name?, description?, category?, tags? }` → `{ scene }` |
| `GET`    | `/api/scenes/:id`                    | `{ scene, elements, appState, files }` |
| `PUT`    | `/api/scenes/:id`                    | save → new version                 |
| `PATCH`  | `/api/scenes/:id`                    | `{ name?, description?, category?, tags?, pinned? }` |
| `DELETE` | `/api/scenes/:id`                    | soft delete                        |
| `GET`    | `/api/scenes/:id/versions`           | version list                       |
| `GET`    | `/api/scenes/:id/versions/:version`  | full scene at version              |
| `POST`   | `/api/scenes/:id/versions/:version/pin` | `{ pinned? }` (default `true`)   |
| `PUT`    | `/api/scenes/:id/thumbnail`          | `image/png` body → stored preview  |
| `GET`    | `/api/scenes/:id/thumbnail`          | the PNG preview (404 if none)      |
| `GET`    | `/api/scenes/:id/semantic`          | compact `{ nodes, edges, texts, sketches }` |
| `PUT`    | `/api/scenes/:id/semantic`          | replace the scene from a semantic graph |
| `POST`   | `/api/scenes/:id/semantic/append`   | merge a semantic fragment           |
| `GET`    | `/api/scenes/:id/markdown`          | readable outline                    |
| `POST`   | `/api/scenes/:id/presence`          | editor → "this scene is open"       |
| `GET`    | `/api/events`                       | SSE stream of `scene-changed`       |
| `POST`   | `/mcp`                              | Model Context Protocol (JSON-RPC)   |

## Type checking

```bash
yarn test:typecheck:server   # from repo root  (tsc -p server/tsconfig.json)
```

`server/` is currently excluded from the repo-wide ESLint pass
(`.eslintignore`); revisit once the shape settles.
