# Screenshots

Four of these PNGs are the genuine output of the repo's own UI checks, captured from the
**built-in demo data** only (the `?demo=1` fixtures); they never show a real lane, project, path or
private text. `keys-form.png` is a setup screenshot of the local keys form, not a dashboard
capture.

## How to (re)capture

Run the two existing checks from the repo root. Each starts `ca dash` on a free port and drives it
with headless Chrome; PNGs land in `checks/out/`.

```sh
node checks/lanes.check.mjs      # writes checks/out/*.png
node checks/office.check.mjs     # writes checks/out/*.png
```

Then copy the four selected files into this folder.

## Source to destination mapping

| Source (`checks/out/`) | Destination (`docs/images/`) | Shows |
|---|---|---|
| `lanes-control-room.png` | `lanes-control-room.png` | Control room: Needs you / Running / Done / Ended |
| `lanes-home.png` | `lanes.png` | Plan home: waves, current step, decisions |
| `lanes-detail-transcript.png` | `lane-detail.png` | Lane progress, token usage, brief steps, steering controls |
| `2-window.png` | `office.png` | Office view: a lane window |

For example, on a POSIX shell:

```sh
cp checks/out/lanes-control-room.png      docs/images/lanes-control-room.png
cp checks/out/lanes-home.png              docs/images/lanes.png
cp checks/out/lanes-detail-transcript.png docs/images/lane-detail.png
cp checks/out/2-window.png                docs/images/office.png
```

`tools/check-readme.mjs` verifies that README.md keeps referencing these files and that every
local image/link target exists.

## Notes

- The checks render the demo fixtures, so nothing local or private is captured.
- Do not edit the product code or the checks to make the screenshots nicer.
- Both checks need Chrome; they skip cleanly (`SKIP`) when no Chrome is found.
