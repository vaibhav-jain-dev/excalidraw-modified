# Design canvas

The library redesign, as eight artboards on one pan/zoom canvas.

`dashboard-redesign/*.dc.html` and `canvas.json` are the **sources** — hand authored, small, reviewable in a diff. `excalidraw-library-redesign.html` is the **build output**: ~4.4 MB of precompiled editor plus the artboards, which is why it is not tracked. Regenerate it with:

```bash
make design
```

Then publish that file as an Artifact to update the canvas in place.

Do not hand-edit the generated file. It carries an escaped state block that reformatting or patching will corrupt — change a `.dc.html` source and re-seed instead. It is also excluded from prettier for the same reason (see `.eslintignore`).
