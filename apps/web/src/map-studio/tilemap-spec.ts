/**
 * Tiny Swords tilemap spec — the autotiling rules for building islands.
 *
 * Tiles are 64×64. A `Tilemap_colorN` atlas is 9 columns × 6 rows. Flat Ground
 * and the grass top of Elevated Ground share the SAME 16-tile, 4-neighbour
 * autotile: for each ground cell, look at its N/E/S/W neighbours — a tile shows
 * grass connecting toward neighbouring ground and a water edge facing water.
 *
 * Bitmask: N=1, E=2, S=4, W=8 → `AUTOTILE[mask]` = `[col,row]` offset inside the
 * grass block of the atlas. (Derived from the official "Tilemap parts" sheet and
 * verified against the real atlas pixels.)
 *
 * This file is the single source of truth for both the editor AND the agent:
 * to build an island you only choose WHICH cells are land (+ elevation) and the
 * engine picks every edge/corner tile, the coastline foam, and the cliff shadows.
 *
 * Layer order (bottom → top), per the docs:
 *   0 BG Color (water)  ·  1 Water Foam  ·  2 Flat Ground
 *   then repeated per elevation level:  Shadow → Elevated Ground
 */
export const TILE = 64;

/** N=1, E=2, S=4, W=8 → [col,row] inside a 4×4 grass block. */
export const AUTOTILE: ReadonlyArray<readonly [number, number]> = [
  [3, 3], // 0  (none)        isolated tile, water on all sides
  [3, 2], // 1  N             bottom cap of a vertical strip
  [0, 3], // 2  E             left cap of a horizontal strip
  [0, 2], // 3  N+E           bottom-left corner
  [3, 0], // 4  S             top cap of a vertical strip
  [3, 1], // 5  N+S           vertical strip middle
  [0, 0], // 6  E+S           top-left corner
  [0, 1], // 7  N+E+S         left edge
  [2, 3], // 8  W             right cap of a horizontal strip
  [2, 2], // 9  N+W           bottom-right corner
  [1, 3], // 10 E+W           horizontal strip middle
  [1, 2], // 11 N+E+W         bottom edge
  [2, 0], // 12 S+W           top-right corner
  [2, 1], // 13 N+S+W         right edge
  [1, 0], // 14 E+S+W         top edge
  [1, 1], // 15 N+E+S+W       center (surrounded by land)
];

/** Grass-top block origins inside a `Tilemap_colorN` atlas (9 cols × 6 rows). */
export const FLAT_GRASS_ORIGIN = { col: 0, row: 0 } as const;
export const ELEV_GRASS_ORIGIN = { col: 5, row: 0 } as const;
/** Cliff faces live at cols 5–8, rows 4–5; stairs at col 0 & 3, rows 4–5. */
export const CLIFF_ORIGIN = { col: 5, row: 4 } as const;

/** 4-neighbour autotile mask. `isLand(col,row)` should return false off-grid. */
export function neighbourMask(c: number, r: number, isLand: (c: number, r: number) => boolean): number {
  let m = 0;
  if (isLand(c, r - 1)) m |= 1; // N
  if (isLand(c + 1, r)) m |= 2; // E
  if (isLand(c, r + 1)) m |= 4; // S
  if (isLand(c - 1, r)) m |= 8; // W
  return m;
}

/** Atlas (col,row) for a FLAT-ground grass cell (cols 0-3 block — water-facing edges). */
export function flatTile(mask: number): { col: number; row: number } {
  const [dc, dr] = AUTOTILE[mask & 15]!;
  return { col: FLAT_GRASS_ORIGIN.col + dc, row: FLAT_GRASS_ORIGIN.row + dr };
}

/** Atlas (col,row) for an ELEVATED-ground grass cell (cols 5-8 block — cliff-top edges). */
export function elevTile(mask: number): { col: number; row: number } {
  const [dc, dr] = AUTOTILE[mask & 15]!;
  return { col: ELEV_GRASS_ORIGIN.col + dc, row: ELEV_GRASS_ORIGIN.row + dr };
}
