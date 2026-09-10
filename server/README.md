# excalidraw-local-server

Local-first storage, rendering, search and MCP server for this Excalidraw fork.
See [`../LOCAL_FIRST_PLAN.md`](../LOCAL_FIRST_PLAN.md) for the full design and
roadmap.

## Status

**Step 1 — skeleton.** Fastify server, SQLite metadata store (`node:sqlite`,
no native deps), scene CRUD + version history, static hosting of the built app.

Not yet: derived markdown/semantic views, full-text/vector search, PNG
rendering, MCP, live-reload websocket.

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
| `POST`   | `/api/scenes`                        | `{ name?, tags? }` → `{ scene }`   |
| `GET`    | `/api/scenes/:id`                    | `{ scene, elements, appState, files }` |
| `PUT`    | `/api/scenes/:id`                    | save → new version                 |
| `PATCH`  | `/api/scenes/:id`                    | `{ name?, tags?, pinned? }`        |
| `DELETE` | `/api/scenes/:id`                    | soft delete                        |
| `GET`    | `/api/scenes/:id/versions`           | version list                       |
| `GET`    | `/api/scenes/:id/versions/:version`  | full scene at version              |
| `POST`   | `/api/scenes/:id/versions/:version/pin` | `{ pinned? }` (default `true`)   |

## Type checking

```bash
yarn test:typecheck:server   # from repo root  (tsc -p server/tsconfig.json)
```

`server/` is currently excluded from the repo-wide ESLint pass
(`.eslintignore`); revisit once the shape settles.
