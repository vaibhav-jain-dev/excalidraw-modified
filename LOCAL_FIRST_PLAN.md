# Local-first Excalidraw — build plan

A self-hosted Excalidraw that runs on **`localhost:3056`** (app + API + MCP, one origin), stores every drawing locally, generates PNG thumbnails, keeps version history, and exposes an LLM-friendly semantic layer with full-text + vector search.

---

## Decisions (locked)

| Question | Choice |
| --- | --- |
| Canonical format on disk | `.excalidraw` JSON (lossless). `scene.md` + `scene.semantic.json` + `scene.mmd` are **regenerated** on every save. |
| Vector store | `sqlite-vec` — embedded in the same SQLite file as FTS5 + metadata. No extra process. |
| Embeddings + text-to-diagram | Local: Ollama (`nomic-embed-text` / `llama3.x`) or Transformers.js fallback. No API keys, fully offline. |
| Server | Single Node process (Fastify) serving `build/` + `/api/*` + `/mcp` on port 3056. |
| Live reload | Lightweight WS "scene `<id>` changed" ping (not the full collab CRDT). |

---

## Why not "switch to markdown"

The `.excalidraw` file is **already JSON**. What makes it token-heavy and opaque to an LLM is that `elements[]` is a flat list of geometry primitives (~15–25 fields each; a labelled box is 2 elements joined by `containerId`). So we keep JSON as canon and _derive_ compact views:

| View | ~tokens for a 6-box/7-arrow chart | Purpose |
| --- | --- | --- |
| raw `.excalidraw` | 4–6k | editor load/save only |
| `scene.mmd` (mermaid) | ~180 | LLM reads/reasons natively; also a projection target |
| `scene.semantic.json` | ~350 | MCP payloads, LLM edits, embedding chunks |
| `scene.md` | ~250 | human-readable, `git diff`, FTS5 source |
| rendered PNG | ~1.1k (vision) | LLM _sees_ layout/color/spatial intent |

`customData` on every element survives save→load→restore (`packages/excalidraw/data/restore.ts:497`) — no schema changes needed for anchors/metadata.

---

## On-disk layout

```
~/.excalidraw-local/
  index.db                       SQLite: scenes, versions, FTS5, vec0 (sqlite-vec)
  scenes/<id>/
    v0001.excalidraw             canonical, one file per saved version
    v0002.excalidraw
    latest.excalidraw            symlink/copy of newest
    scene.md                     regenerated
    scene.semantic.json          regenerated
    scene.mmd                    regenerated (when graph-shaped)
  files/<fileId>.bin             pasted/embedded images (dedup by content hash)
  thumbs/<id>.png                256px scene thumbnail
  renders/<id>/<anchor>.png      cached anchor-cropped exports
```

Scene JSON is pretty-printed → the whole `scenes/` tree is a clean git repo if the user wants history/PR review for free (optional `git commit` after each save).

---

## Server workspace

New workspace `server/` (add to root `package.json` `workspaces`).

```
server/
  src/
    index.ts          Fastify: static build/, /api, /mcp, /ws
    config.ts         port 3056, data dir, ollama url
    db.ts             better-sqlite3 + sqlite-vec load; migrations
    store/
      scenes.ts       CRUD + version pruning (keep last N + pinned)
      files.ts        content-addressed blob store
    derive/
      toMarkdown.ts    elements[] -> scene.md
      toSemantic.ts    elements[] -> {nodes,edges,notes}  (collapse container+label,
                       resolve startBinding/endBinding -> edges, frameId -> groups)
      toMermaid.ts     semantic -> mermaid (graph-shaped scenes only)
      fromSemantic.ts  semantic diff -> element ops (+ ELK / mermaid-to-excalidraw layout)
    search/
      index.ts         reindex(sceneId): regen md/semantic/mmd, FTS rows, embeddings
      embed.ts         ollama /api/embeddings, batched, cached by chunk hash
    render/
      browser.ts       persistent Playwright page + harness calling exportToBlob/exportToSvg
    routes/
      scenes.ts  files.ts  render.ts  search.ts
    mcp/
      server.ts        streamable-HTTP MCP at /mcp  (+ bin/ stdio entry)
      tools.ts         thin client over the same /api handlers
    ws.ts              broadcast {type:"scene-changed", id}
```

Dev: run Vite (`excalidraw-app`) on 3056 with `server.proxy` `/api` `/mcp` `/ws` → Fastify on 3057. Prod: `yarn build` then Fastify serves `excalidraw-app/build` on 3056 directly.

---

## HTTP API

```
GET    /api/scenes                       [{id, name, tags, updatedAt, elementCount, thumbUrl}]
POST   /api/scenes                        {name?} -> {id}
GET    /api/scenes/:id                    {elements, appState, files}   (latest)
PUT    /api/scenes/:id                    {elements, appState, files, thumb?} -> creates version
PATCH  /api/scenes/:id                    {name?, tags?, pinned?}
DELETE /api/scenes/:id
GET    /api/scenes/:id/versions           [{v, createdAt, elementCount, pinned}]
GET    /api/scenes/:id/versions/:v        full scene at version
POST   /api/scenes/:id/versions/:v/pin
GET    /api/scenes/:id/semantic           scene.semantic.json
GET    /api/scenes/:id/markdown           scene.md
GET    /api/scenes/:id/mermaid            scene.mmd
GET    /api/scenes/:id/png                ?scale=2&theme=dark&background=1&anchor=<name>
GET    /api/scenes/:id/svg
GET    /api/files/:fileId
POST   /api/files                         binary -> {fileId}
GET    /api/search?q=...&mode=fts|vector|hybrid   -> [{sceneId, name, anchor?, snippet, score}]
POST   /api/generate                      {prompt, sceneId?} -> semantic graph (ollama) -> elements
```

---

## Frontend changes (small, localized)

1. **`excalidraw-app/data/`** — add `ServerData.ts` alongside `LocalData.ts`:

   - `ServerData.save(id, elements, appState, files, thumb)` — debounced `PUT`.
   - keeps IndexedDB (`LocalData`) as offline cache; **server is source of truth**, IDB is fallback.

2. **`excalidraw-app/App.tsx:715` `onChange`** — after `LocalData.save(...)`, if a `#local=<id>` scene is active: generate thumbnail via `exportToBlob` (`packages/excalidraw/index.tsx:426`) and call `ServerData.save(...)`. Thumbnails cost the server nothing for scenes opened in a tab.

3. **`excalidraw-app/App.tsx:217` `initializeScene`** — add a `#local=<id>` branch next to the existing `#json=` / `#url=` / `id=` handling: `GET /api/scenes/:id`, `updateScene`. Also handle `&anchor=<name>` → scroll/zoom to the element whose `customData.anchor` matches.

4. **New dashboard route `/`** (new `excalidraw-app/components/Dashboard/`):

   - thumbnail grid (`GET /api/scenes`), search box (`GET /api/search`), tag filter.
   - "New drawing" → `POST /api/scenes` → `/#local=<id>`.
   - per-card: rename, pin, delete, "history" drawer (`/versions`).
   - version drawer shows two rendered PNGs side by side + added/removed element-id diff.

5. **WS client** — subscribe; on `scene-changed` for the open scene that _this_ tab didn't originate, reload elements (so MCP writes appear live).

6. **`.env.development`** — `VITE_APP_PORT=3056`.

---

## Semantic layer detail

`toSemantic.ts` walks `elements[]`:

- **node** = each bindable element (`rectangle|diamond|ellipse|frame|image|embeddable|stickyNote`); its label = the text element whose `containerId` points at it, merged in as `text`.
- **edge** = each `arrow`/`line` with `startBinding`/`endBinding`; `from`/`to` = bound element ids; `label` = bound text; direction from arrowheads.
- **note** = free `text` / sticky notes not bound to anything; `near` = nearest node by bbox.
- **group** = `frameId` (frame name as group label) and `groupIds`.
- carry `customData.anchor`, color role (semantic: "danger" if red-ish, etc.), and position bucket (`row`/`col` index from a coarse grid) so layout survives round-trips.

```json
{
  "id": "9fq2",
  "name": "Ingest pipeline",
  "nodes": [
    {
      "id": "n1",
      "kind": "box",
      "text": "Kafka",
      "anchor": "kafka",
      "group": "sources"
    },
    {
      "id": "n2",
      "kind": "box",
      "text": "Flink job",
      "anchor": null,
      "group": "compute"
    }
  ],
  "edges": [{ "from": "n1", "to": "n2", "label": "events", "style": "solid" }],
  "notes": [{ "text": "backpressure TODO", "near": "n2" }]
}
```

`fromSemantic.ts` = reverse: diff incoming semantic vs current → create/update/delete element ops. New nodes/edges get positions from ELK layered layout (or reuse `@excalidraw/mermaid-to-excalidraw@2.2.2` layout, already a dep). Human position-only edits never change semantic structure → no merge conflict between LLM edits and hand edits.

---

## Search

- **FTS5** virtual table over: scene name, tags, `scene.md`, and each text element individually (row → `sceneId`, `elementId`, `anchor`). Rebuilt in `reindex()`.
- **sqlite-vec (`vec0`)**: embed each semantic node/edge/note as a short sentence ("box 'Kafka' in group sources connects to 'Flink job' labeled events") + the full `scene.md`. Store `sceneId` + `anchor` per vector.
- **hybrid**: FTS candidates ∪ vector top-k, reciprocal-rank fusion, return deep links `/#local=<id>&anchor=<a>`.
- Ollama down → skip embeddings, FTS still works; `reindex` marks scene `vec_dirty` for later.

---

## MCP tools (`/mcp`, streamable HTTP + stdio)

Thin wrappers over the same route handlers — one code path.

| Tool | Returns |
| --- | --- |
| `list_scenes()` | id, name, tags, updatedAt |
| `search_scenes(query, mode?)` | ranked hits w/ snippet + deep link |
| `get_scene(id, as?: "semantic"\|"mermaid"\|"markdown")` | compact view (default semantic) |
| `get_scene_image(id, anchor?)` | image content block (LLM sees it) |
| `create_scene(name, mermaid?\|semantic?)` | new id (+ initial content via `fromSemantic`) |
| `update_scene(id, semantic)` | applies diff, bumps version, WS ping |
| `append_elements(id, semantic_fragment)` | adds nodes/edges, auto-layout |
| `set_anchor(id, elementRef, name)` | writes `customData.anchor` |
| `render_scene(id, opts)` | PNG/SVG path or base64 |

Register once: `claude mcp add --transport http excalidraw http://localhost:3056/mcp`.

---

## Rendering

`render/browser.ts`: keep one Playwright Chromium page alive loading a minimal harness (`server/render/harness.html`) that imports the built Excalidraw and exposes `window.render(scene, opts)` → `exportToBlob` / `exportToSvg`. Used for:

- thumbnails of scenes never opened in a browser
- MCP `render_scene`
- `?anchor=` crops (compute element bbox from `latest.excalidraw`, pass as export region)

Scenes edited in a live tab upload their own client-rendered thumbnail on save → server render only on demand.

---

## Build order

1. ✅ **Skeleton** — `server/` workspace, Fastify on 3057, serve Vite proxy, `db.ts` + migrations (scenes, versions), `POST/GET/PUT /api/scenes`. Port config to 3056.
2. ✅ **Save/load + dashboard** — `ServerData.ts`, `/d/<id>` route, dashboard grid, client thumbnails on save.
3. ✅ **Versions** — version files + pruning, dashboard history drawer (restore / pin any past version). _(No side-by-side PNG diff yet — restore + reopen is the workflow.)_
4. ✅ **Derive layer** — `toMarkdown` / `toSemantic` / `toMermaid`, `/api/scenes/:id/{semantic,markdown,mermaid}`.
5. ✅ **FTS search** — FTS5 table, indexed on create/save/meta-edit, `/api/search?mode=fts`, dashboard search box.
6. ✅ **MCP** — `/mcp` + stdio, full tool set, SSE live-sync (used in place of a separate WS ping).
7. ✅ **Vectors** — `sqlite-vec` (loaded via `node:sqlite`'s extension support), Ollama embed, hybrid search (RRF), `/api/generate` text-to-diagram. Gracefully degrades to FTS-only when Ollama can't embed.
8. ✅ **Anchors + server render** — `customData.anchor` (round-trips through the semantic graph), a persistent headless-Chromium render service (drives the app's own `window.h`, not a Playwright harness — see `server/src/render/browser.ts`), `?anchor=` crops, `set_anchor` / `list_anchors` / `get_scene_image` MCP tools.
9. ⬜ **Polish** — git-commit-per-save option, Docker image. _(Tag management and export-all are effectively covered by the existing tags field + per-scene export.)_

Each step ships something runnable. Steps 1–3 are the "open drawings, see previous saves from the browser" core; 4–7 are the LLM/search agenda; 8 is stable named anchors. Only step 9 (packaging polish) remains.

---

## Open items to decide later

- Auth: none (localhost only) vs. a single shared token for LAN access.
- Multi-user real collab: out of scope for v1; WS ping only. Revisit with `excalidraw-room` if needed.
- Conflict when the same scene is edited in two tabs offline: last-write-wins + keep the overwritten version as a branch. Acceptable for single-user.
