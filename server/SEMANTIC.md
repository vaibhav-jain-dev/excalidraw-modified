# Scene formats, from an LLM's point of view

Four views of the same drawing exist. This is the reasoning behind which one
an agent should reach for, measured against a real scene in this library
(`mtz3cciv-a06de6d50e` — 14 elements, two shapes and three pencil strokes).

| view | bytes | ~tokens | vs raw | round-trips? |
| --- | ---: | ---: | ---: | --- |
| raw `.excalidraw` | 31 035 | 7 759 | 1× | yes — it *is* the file |
| `scene.semantic.json` | 5 500 | 1 375 | 5.6× | **yes** |
| `outline` | 759 | 190 | **41×** | no |
| `outline?summary=1` | 301 | 75 | **103×** | no |
| `scene.md` | 161 | 40 | 193× | no |
| `scene.mmd` | 104 | 26 | 298× | no |

The headline: a drawing with **two shapes on it** cost 1 375 tokens in the
semantic view. 4.5 KB of that 5.5 KB was one pencil stroke's `points` array.
Everything below follows from staring at that number.

---

## Saving is not indexing

A save writes one file, bumps the version row, reconciles the graph and
returns — 16 ms on a small scene. Everything else is queued:
`scene.semantic.json`, `scene.md`, `scene.mmd`, the FTS5 rows and the
embeddings, all on a single background worker.

| on the request | on the worker |
| --- | --- |
| write `scene.excalidraw` | derive the three views |
| bump the version row | replace the FTS5 rows |
| **reconcile the graph** | re-embed |
| enqueue and return | |

The graph stays on the request path deliberately. It is in-memory and cheap,
and an agent that tags an element and then asks for that tag has to see it —
read-after-write matters more there than the millisecond it costs. Only the
expensive, eventually-consistent work is deferred.

The queue is coalesced per scene (five saves in ten seconds index once,
against the last state), runs one job at a time, re-reads the scene from disk
so every job is idempotent, and persists its pending ids so a restart picks
them back up. `index_status` (MCP) and `GET /api/index/status` report what is
still draining — the drawing is already safe on disk; it is search that is a
moment behind.

---

## Round 1 — exploration cost

The question an agent actually asks first is never "give me the geometry", it
is "is this drawing the one I want?". Paying 1 375 tokens to find out is the
wrong trade, and it gets worse linearly with ink: freehand strokes carry
hundreds of points each and a page of handwriting is tens of thousands of
tokens that say nothing.

**Decision.** Drop the geometry, keep the fact that geometry exists. A stroke
becomes `{id, kind, at: [x,y,w,h], points: 214}`. The agent learns there is a
214-point scribble in that corner and can go get the real points from the raw
scene if it ever needs them — which, in practice, is never, because what it
wants from a scribble is the *rendered PNG*, not the coordinates.

Corollary, and the reason for the `summary` level: the cheapest useful answer
is not a small scene, it is *no scene*. Name, extent, counts, clusters — 75
tokens — is enough to decide whether to read further. Reading 30 drawings to
find one now costs ~2 000 tokens instead of ~230 000.

## Round 2 — can it get information *precisely*?

Compression is worthless if the agent then cannot act on what it found. The
failure mode to avoid is a view so abstracted that "the red box top-left" has
no addressable identity, forcing a second full read to locate it.

**Decision.** Every entry keeps its **real element id**. Not a short handle,
not an index — the id that `tag_element`, `set_anchor`, `render.png?anchor=`
and the graph's `box:<scene>/<element>` nodes all already speak. A short `n1`
ref would have saved ~6 tokens an element and cost a resolution layer in every
write path, plus a class of bug where a stale ref points at the wrong shape
after an edit. Not worth it.

Two structural additions do more for precision than any id scheme:

- **`in`** — the smallest node fully containing this one. Containment is what
  "inside that box" means, and it is exactly the question a region comment
  asks. Computing it server-side once beats making the model compare
  rectangles.
- **reading order** — banded by row, then left to right. Coordinates only
  *imply* an order; emitting the array already sorted makes the JSON read like
  a document, for free.

Both are derived, neither is authority, and both were things a model
previously had to reconstruct from `x`/`y` by hand.

## Round 3 — what gets lost, and is the loss honest?

A lossy view that lies is worse than a verbose one. If an agent reads an
outline and concludes "this drawing has two shapes", that must be **true**,
not "two shapes and some things I didn't mention".

**Decision.** Anything dropped is counted, in `omitted`:
`{"embeddable": 1, "emptyText": 2}`. Unbound arrows — an arrow attached to
nothing carries no relationship — degrade to sketches rather than becoming
edges that claim a connection that isn't there. The model can always tell the
difference between "there is nothing here" and "there is something here I am
not describing".

This is also why the outline is **read-only and never written back**.
`toSemantic`/`fromSemantic` stay lossless and remain the authoring format. If
the compact view were writable, an agent reading an outline and saving it
would silently delete every pencil stroke in the drawing. Two formats is the
price of not having that bug.

## Round 4 — can this replace prose?

Partly, and it is worth being exact about where the line is.

**It replaces prose for structure.** Clusters plus reading order plus `in`
plus labels describe the *arrangement* of a diagram better than a paragraph
would, and more cheaply. `scene.md` and `scene.mmd` are cheaper still (40 and
26 tokens) and are the right answer when a scene is genuinely a node/edge
graph or genuinely a list of notes — `isGraphShaped()` already decides this
and skips the mermaid file when it would lie.

**It does not replace the image for spatial intent.** Nothing in JSON conveys
"these two clusters are drawn to mirror each other" or what a 214-point
squiggle actually depicts. The rendered PNG at ~1 100 vision tokens remains
the cheapest way to convey *what a drawing looks like*, and the outline's job
is to tell the model whether spending them is worth it.

So the ladder an agent should climb, cheapest first:

1. `get_scene_outline {summary: true}` — 75 tokens. Is this the right drawing?
2. `get_scene_outline` — ~190 tokens. What is on it, what is inside what, what
   is tagged, what are the element ids?
3. `get_scene_image` — ~1 100 tokens. What does it actually look like?
4. `get_scene` — the lossless semantic format. Only when writing.

And the graph sits *below* all four: `describe_scene`, `list_tags`, `get_tag`
and `neighbours` answer "which drawing, and what is it about" without opening
any of them. After step 3 the ladder runs back down — `annotate_scene` writes
what looking at the image taught you back into the graph, so the next agent
can stop at step 0.

---

## The formats

### `outline` — read view

`GET /api/scenes/:id/outline` · `?summary=1` · MCP `get_scene_outline`

```jsonc
{
  "name": "Ingest pipeline",
  "bbox": [378, -767, 437, 1677],          // the drawing's real extent
  "counts": { "nodes": 2, "edges": 0, "texts": 0, "sketches": 3 },
  "clusters": [                             // proximity groups, top to bottom
    { "at": [378, -767, 335, 312], "count": 2, "gist": "unlabelled" },
    { "at": [392, 420, 423, 490], "count": 2, "gist": "tested" }
  ],
  "nodes": [                                // reading order
    { "id": "2A5Fz…", "shape": "ellipse", "at": [442, 420, 373, 330] },
    { "id": "gHvN1…", "shape": "rectangle", "text": "tested",
      "at": [392, 790, 260, 120], "in": "2A5Fz…", "tags": ["broken-code"],
      "bg": "#b2f2bb" }
  ],
  "edges":    [{ "id": "ar1", "from": "n…", "to": "n…", "text": "on failure" }],
  "texts":    [{ "id": "t1", "text": "…", "at": [x, y], "in": "n…" }],
  "sketches": [{ "id": "f1", "kind": "path", "at": [378, -767, 312, 158],
                 "points": 214 }],
  "omitted":  { "emptyText": 4 }
}
```

### `semantic` — authoring format

`GET|PUT /api/scenes/:id/semantic` · MCP `get_scene` / `update_scene`

Lossless and round-trippable: `{nodes, edges, texts, sketches}` with full
point arrays. Write through this and nothing else.

### The graph — what an image *means*

`graph.json`. A local graph store held in memory and written as one file:
**not SQLite**, deliberately. It carries everything known about a drawing
that is not the drawing itself.

**Node kinds** — `scene`, `box` (one element inside a scene), `tag`,
`category`, `folder`.

**Edge kinds**

| edge | from → to | source |
| --- | --- | --- |
| `tagged` | scene → tag | derived, or agent |
| `tagged-part` | box → tag | derived |
| `contains` | scene → its tagged boxes | derived |
| `links-to` | scene → scene (`render: embed \| title`) | derived |
| `filed-under` | scene → category leaf | derived |
| `lives-in` | scene → folder leaf | derived |
| `child-of` | category → parent, folder → parent | derived |

Category and folder are **separate axes** and both nest: a slash-separated
path becomes a chain of nodes joined by `child-of`, so
`Architecture/Storage/Graph store` is three nodes deep and the scene is filed
under the leaf. Nesting costs nothing and needs no table.

**Derived vs authored.** Every edge above is re-derived from the scene on
every save and on every metadata edit, so the graph cannot drift from what is
actually drawn — that is why a lost `graph.json` costs a
`POST /api/graph/rebuild` and never data.

The exception, and the reason the graph exists at all: an LLM can *look at
the rendered image* and add what no amount of parsing would find — that a
diagram is a state machine, that a scribble is a retry ladder. Those edges are
written `by: "agent"`, and they are the one thing a re-derive must not
destroy. `reconcileScene` skips them and `rebuild` calls `resetDerived`, which
keeps agent edges and the note attached to each scene. `DELETE
/api/scenes/:id/annotate` is the only thing that removes them.

So the graph is the image's information layer: **folder, category, tags,
boxes and links derived from the file; meaning added on top by something that
can see.** `describe_scene` returns all of it in one read, with every tag
marked as a person's or a model's.

---

## Reading one region

`GET /api/scenes/:id/outline?bbox=x,y,w,h` · MCP `get_scene_outline {bbox}`.
Limits the outline to elements overlapping that rectangle, reports the region
back, and counts what it left out in `outsideRegion` — so a narrowed read is
never mistaken for an empty drawing. A shape's bound label is kept regardless
of its own position, so labels never vanish from their boxes.

Pass a comment's `x/y/width/height` straight in to answer "what is inside the
box this note points at".

## Templates

23 solved layouts in `derive/templates.ts`, reached through `list_templates`
and `apply_template`. They exist because hand-computed coordinates are where
generated diagrams go wrong — overlapping boxes, crossing arrows, spacing that
drifts. Each takes plain content and returns a finished `SemanticScene`.

Process `flowchart` `decision` `swimlane` `cycle` `statemachine` `sequence` ·
Structure `architecture` `layers` `erd` `orgchart` `mindmap` `network`
`fishbone` · Planning `kanban` `timeline` `gantt` `matrix` `quadrant` ·
Thinking `funnel` `venn` `proscons` · Sketching `wireframe` `storyboard`

`network` is the escape hatch: arbitrary nodes and edges on a ring, for when
no shaped template fits. Every template is tested for zero overlapping nodes
(containment exempt, `venn` exempt because intersecting *is* the diagram),
edges that point at nodes that exist, compiling to real elements, and
surviving an empty spec. The registry is the single source for
`list_templates`, so a template cannot be added without documenting what it
takes.

## Left open

- **Cluster naming.** `gist` is the first few labels joined. An unlabelled
  cluster reads as `"unlabelled"`, which is honest but useless — a one-line
  description from the local model at index time would be much better, and the
  background worker is the right place for it.
- **Diffs.** Nothing yet answers "what changed between v87 and v103" in fewer
  tokens than reading both. An outline-level diff would be small and is the
  obvious next format.
