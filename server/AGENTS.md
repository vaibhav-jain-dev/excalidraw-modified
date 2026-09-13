# excalidraw-local — agent guide

A local library of drawings. Each has a **folder** (where it sits), one
**category** (slash-separated, nests), **tags** (many, on the whole drawing or
on a single box inside it), and **links** to other drawings. The graph holds
all of that; the drawing holds only shapes.

## Rules

1. **Every id comes from a tool result.** Never construct, shorten or guess a
   scene id, element id or tag. If you don't have one, call a tool that
   returns one.
2. **Don't describe what you haven't read.** No result means say so — not a
   plausible answer. Tool errors get reported as-is; never retry with invented
   arguments.
3. **`get_scene_outline` is lossy on purpose.** `sketches[].points` is a
   *count*, not geometry. `omitted` lists what isn't shown. Report its counts,
   never "this drawing only has N things".
4. **You cannot see a drawing from JSON.** Coordinates don't tell you what a
   sketch depicts. If appearance matters, call `get_scene_image` and look.
5. **Write only the semantic format.** `update_scene` / `append_to_scene` take
   what `get_scene` returned. Never write an outline back — it has no points
   and would delete every freehand stroke.
6. **Your tags are yours.** `annotate_scene` marks them `by: "agent"`;
   `set_scene_meta tags` records them as the user's. Don't blur the two, and
   don't present your guesses as theirs.
7. **Search ranks candidates, it doesn't answer.** Confirm by reading before
   asserting.
8. **Only resolve a comment you actually fixed.** `resolve_comment` deletes
   the thread.
9. **Don't hand-place boxes.** Reach for `apply_template` first; only write
   raw coordinates when no template fits, and say which you did.

`id` defaults to the drawing currently open in the editor; pass it explicitly
when acting on another one.

## Cost ladder — stop as soon as you have the answer

| step | call | ~tokens |
| --- | --- | ---: |
| 0 | `describe_scene`, `list_tags`, `get_tag`, `neighbours` | 20–100 |
| 1 | `get_scene_outline {summary:true}` | ~75 |
| 2 | `get_scene_outline` | ~190 |
| 3 | `get_scene_image` | ~1100 |
| 4 | `get_scene` | 1000s — **only to write** |

Step 0 answers "which drawing, and what is it about" without opening one.
After step 3, write what you learned back with `annotate_scene` so the next
agent can stop at step 0.

## Tools

Arguments are in each tool's schema — this is what the schema can't say: which
one to reach for.

**Find which drawing** — `list_scenes` · `search_scenes` (covers titles,
categories and the text drawn inside diagrams) · `get_active_scene` ·
`list_tags` · `get_tag` · `neighbours` · `graph_stats`

**Read one** — `describe_scene` (graph only, no drawing opened) ·
`get_scene_outline` · `get_scene_image` · `get_scene` · `links` ·
`list_anchors`

**Add meaning** — `annotate_scene` (what *seeing* the image told you) ·
`tag_element` (tag one box, not the file) · `link_drawings` · `set_anchor`

**Draw** — `list_templates` then `apply_template`. Templates solve the
geometry; hand-placed coordinates are where generated diagrams overlap and
drift. Every entry ships a working `example` — copy that shape rather than
inferring one from the table below. `apply_template` with `mode: "new"` takes
`category`, `folder` and `tags`, so a new diagram lands filed.

| template | spec |
| --- | --- |
| `flowchart` | `steps[]`, `direction: down\|right`, `endpoints` |
| `decision` | `question`, `yes[]`, `no[]`, `then` |
| `swimlane` | `lanes[{name, steps[]}]` |
| `cycle` | `steps[]` |
| `statemachine` | `states[]`, `transitions[{from, to, on}]`, `initial` |
| `sequence` | `actors[]`, `messages[{from, to, text}]` |
| `architecture` | `tiers[{name, nodes[{label, sub}]}]`, `links[[a,b]]` |
| `layers` | `layers[{name, items[]}]` |
| `erd` | `entities[{name, fields[]}]`, `relations[{from, to, label}]` |
| `orgchart` | `root{label, sub, children[...]}` |
| `mindmap` | `centre`, `branches[{label, children[]}]` |
| `network` | `nodes[]`, `edges[[from, to, label]]` — the escape hatch |
| `fishbone` | `problem`, `causes[{label, items[]}]` |
| `kanban` | `columns[{name, cards[]}]` |
| `timeline` | `events[{when, label}]` |
| `gantt` | `tasks[{label, start, end}]`, `units[]` |
| `matrix` | `rows[]`, `columns[]`, `cells[][]` |
| `quadrant` | `xAxis[l,r]`, `yAxis[b,t]`, `items[{label, x, y}]` 0..1 |
| `funnel` | `stages[]`, `direction: down\|up` (up = pyramid) |
| `venn` | `sets[]` (2–3), `overlap` |
| `proscons` | `subject`, `pros[]`, `cons[]` |
| `wireframe` | `device: browser\|phone`, `nav[]`, `blocks[{label, height}]` |
| `storyboard` | `frames[]`, `columns` |

23 of them. `architecture` wires a tier to the one above only when it can be sure: one
parent above means everything hangs off it, equal widths join index to index,
anything else is left to `links`. `sub` is a second line — a port, a runtime.

**Write** — `create_scene` · `update_scene` (replaces) · `append_to_scene` ·
`set_scene_meta` · `delete_scene` · `generate_diagram`

**Review** — `list_comments` · `reply_to_comment` · `resolve_comment`

A save returns before search catches up — tags and links are live at once, but
derived text and embeddings are indexed in the background. `index_status` says
what is still draining.

## Semantic format (writing)

`{nodes, edges, texts, sketches}`. `nodes` are shapes with `id`, `shape`,
`text`, optional `x/y/w/h` (omit and they're laid out on a grid); `edges` join
node ids; `sketches` are freehand paths with full point arrays. Lossless and
round-trippable — get it from `get_scene`, hand it back changed.
