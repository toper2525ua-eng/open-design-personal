---
name: tiny-swords-island
description: |
  Generate or edit a top-down Tiny Swords island map for Open Design's Map Studio
  (the "Карта" tab). Writes a compact island.map.json (a terrain grid + grass colours +
  objects + stairs) to the project root; the Map Studio renders it when the user clicks
  "Завантажити острів від Клода". Use whenever the user asks (in any language) to
  generate, redo, or edit an island / game map / level for the tile builder.
triggers:
  - "згенеруй острів"
  - "згенеруй карту"
  - "зроби острів"
  - "острів з"
  - "редагуй острів"
  - "generate island"
  - "generate a map"
  - "tiny swords island"
od:
  mode: utility
  category: game-assets
---

# Tiny Swords island generator

The user builds a top-down tile map in Open Design's Map Studio (the **Карта** tab). Your
job is to write — or edit — **`island.map.json`** in the **project root** (your current
working directory). The studio reads that one file and renders the island. Do not build
HTML, run servers, or touch anything else unless asked; this skill is only the map file.

## Grid
- 24 columns (`col`, x, left→right) × 16 rows (`row`, y, top→bottom). Top-down view.
- `col` ∈ 0..23, `row` ∈ 0..15.

## File shape — write EXACTLY this
```json
{
  "version": 1,
  "cols": 24,
  "rows": 16,
  "terrain": ["........................", "...(16 strings, 24 chars each)..."],
  "flatColor": 0,
  "hiColor": 2,
  "objects": [{ "col": 6, "row": 4, "asset": "Tree" }],
  "stairs": [{ "col": 9, "row": 7 }]
}
```

### `terrain` — exactly 16 strings, each exactly 24 characters
Character = height level of that cell:
- `.` = sea (water)
- `1` = flat land (level 1)
- `2` = raised plateau (level 2)
- `3` = higher plateau (level 3)

Rules:
- The island is ONE connected landmass in the sea, with an **organic** outline (not a
  rectangle): bays, capes, a couple of single-tile points. Surround it with `.` sea.
- A `2` must sit on or next to `1` (build terraces); a `3` only on/next to `2`. Never leave
  a `2`/`3` floating in the sea or with no lower land around it.
- Re-count every row: 16 rows, 24 chars per row. This is the #1 thing to get right.

### colours
- `flatColor` and `hiColor` are grass-tileset indices: integers `0..N-1`, where N is the
  number of `Tilemap_colorX` images in the pack's Tileset folder (look it up; usually 5).
  Choose two DIFFERENT indices — e.g. a lighter green for the flat ground and another for
  the plateau.
- (Advanced/optional) For per-cell colour send `flatColors` / `hiColors` as 16×24 grids of
  colour-index digits (`.` for sea). A single int per layer is usually enough.

### `objects` — decorations, on LAND only
- `asset` is matched as a **case-insensitive substring** against the pack's image
  filenames. So first discover real names: search the pack for decoration / tree / rock /
  resource images (e.g. files under folders like `Decorations`, `Trees`, `Resources`) and
  use their base names — e.g. `"Tree"`, `"Bushe"`, `"Rock"`, `"Mushroom"`, `"Sheep"`.
- Place a handful, scattered, never dense, and NEVER on a `.` sea cell.

### `stairs` — connect a plateau down to the ground
- Each entry is the staircase's UPPER cell `{col,row}`: pick a cell on the SOUTH edge of a
  `2` plateau (a `2` whose cell directly below is `1`). The studio renders the 2-tile
  staircase and auto-picks the left/right side from the surrounding height.
- 0–3 staircases, or `[]` if none fit.

## Workflow
1. If `island.map.json` already exists and the user asked to EDIT, read it first and change
   only what they requested (keep the rest).
2. Compose the JSON per the rules. Then re-verify: `terrain` has 16 rows, each 24 chars.
3. Write it to `island.map.json` in the project root (overwrite the whole file).
4. Reply briefly with what you made, and remind them to click
   **"↻ Завантажити острів від Клода"** in the Карта tab to see it.
