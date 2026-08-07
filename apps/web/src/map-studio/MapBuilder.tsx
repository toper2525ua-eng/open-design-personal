import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

import { mapObjectAssets, tilesetAssets, type PackAsset, type PackManifest } from './asset-manifest';
import { elevTile, flatTile } from './tilemap-spec';

interface MapBuilderProps {
  projectId: string;
  manifest: PackManifest;
  /** Existing *.map.json file names in the project — for the "open map" dropdown. */
  mapFiles?: string[];
  /** Re-fetch the project file list (so a freshly saved map shows up in the dropdown). */
  onRefreshFiles?: () => Promise<void> | void;
}

interface PlacedObject {
  id: number;
  src: string;
  natW: number;
  natH: number;
  animated: boolean;
  frames?: number;
  cellW?: number;
  cellH?: number;
  col: number;
  row: number;
  /** Root anchor in canvas pixels — the exact point under the cursor when dropped.
   *  When present it overrides the legacy col/row (cell bottom-centre) anchoring. */
  ax?: number;
  ay?: number;
}
type Brush = 'terrain' | 'object';

const DEFAULT_COLS = 24;
const DEFAULT_ROWS = 16;
const MIN_DIM = 6;
const MAX_DIM = 48;
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
/** Bleed ring: paintable cells AROUND the design area (cropped out of the photo). */
const MAX_BLEED = 4;
const CAN = 30; // logical cell size in px; visual size = CAN * zoom (CSS zoom on the canvas)
const OBJ_H = Math.round(CAN * 2.2);
const FOAM = Math.round(CAN * 2.6);
const PAL = 40;
const MAX_LEVEL = 3; // flat (1) + two elevations
/** Which tileset colour each elevation level uses (1-based level). */
const LEVEL_COLOR = [0, 0, 2, 4];
const LEVEL_LABEL = ['', '1 · Рівнина', '2 · Висота', '3 · Висота'];

function rawUrl(projectId: string, filePath: string): string {
  const enc = filePath.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${projectId}/raw/${enc}`;
}

/** Clamp a possibly-bad value to an integer in [lo, hi], falling back to dflt. */
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function atlasCellBg(url: string, col: number, row: number, gc: number, gr: number, disp: number): CSSProperties {
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${gc * disp}px ${gr * disp}px`,
    backgroundPosition: `-${col * disp}px -${row * disp}px`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
  };
}

/** Looping animated square sprite (water foam) with a per-instance start offset. */
function AnimTile(props: { url: string; frames: number; size: number; delayMs: number }) {
  const { url, frames, size, delayMs } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const stripW = size * frames;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = el.animate(
      [{ backgroundPosition: '0px 0px' }, { backgroundPosition: `-${stripW}px 0px` }],
      { duration: Math.max(600, frames * 90), easing: `steps(${frames})`, iterations: Infinity, delay: delayMs },
    );
    return () => a.cancel();
  }, [url, frames, stripW, delayMs]);
  return (
    <div
      ref={ref}
      style={{
        width: size,
        height: size,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${stripW}px ${size}px`,
        backgroundPosition: '0px 0px',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/** Static or animated object sprite, sized to a target height (width by aspect). */
function Sprite(props: {
  url: string;
  animated: boolean;
  frames?: number;
  cellW?: number;
  cellH?: number;
  natW: number;
  natH: number;
  height: number;
}) {
  const { url, animated, frames, cellW, cellH, natW, natH, height } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const hasFrames = !!frames && frames > 1 && !!cellW && !!cellH;
  const aw = hasFrames ? cellW! : natW;
  const ah = hasFrames ? cellH! : natH;
  const width = Math.max(1, Math.round(height * (aw / ah)));
  const stripW = width * (frames ?? 1);
  const loop = animated && hasFrames;
  useEffect(() => {
    if (!loop) return;
    const el = ref.current;
    if (!el) return;
    const anim = el.animate(
      [{ backgroundPosition: '0px 0px' }, { backgroundPosition: `-${stripW}px 0px` }],
      { duration: Math.max(500, frames! * 110), easing: `steps(${frames})`, iterations: Infinity },
    );
    return () => anim.cancel();
  }, [url, frames, stripW, loop]);
  if (hasFrames) {
    return (
      <div
        ref={ref}
        style={{
          width,
          height,
          backgroundImage: `url("${url}")`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${stripW}px ${height}px`,
          backgroundPosition: '0px 0px',
          imageRendering: 'pixelated',
        }}
      />
    );
  }
  return <img src={url} alt="" style={{ width, height, imageRendering: 'pixelated', display: 'block' }} />;
}

const STORAGE_PREFIX = 'od-map-studio:v5:';
/** A hand-stamped atlas tile (a stair / cliff piece) painted onto one cell. */
interface TileStamp {
  /** Cell index = row * GRID_COLS + col. */
  i: number;
  /** Atlas tile column + row inside the `Tilemap_colorN` sheet. */
  col: number;
  row: number;
  /** Which tileset colour (atlas index) to draw it from. */
  color: number;
}
interface SavedDoc {
  elev: number[];
  objects: PlacedObject[];
  /** Grass colour of the FLAT (level-1) layer, per cell. */
  colorsFlat?: number[];
  /** Grass colour of the ELEVATED (level 2+) layer, per cell. */
  colorsHi?: number[];
  /** Hand-painted stair / cliff tiles — at most one per cell. */
  tiles?: TileStamp[];
  /** FULL grid dimensions in cells (design area + 2×bleed ring; default 24×16). */
  cols?: number;
  rows?: number;
  /** Visual zoom of the canvas (CSS zoom on the render). */
  zoom?: number;
  /** Paintable bleed ring thickness in cells around the design area (default 0). */
  bleed?: number;
}
function loadDoc(projectId: string): SavedDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedDoc>;
    if (!d || !Array.isArray(d.elev)) return null;
    const cols = clampInt(d.cols, MIN_DIM, MAX_DIM, DEFAULT_COLS);
    const rows = clampInt(d.rows, MIN_DIM, MAX_DIM, DEFAULT_ROWS);
    const cells = cols * rows;
    const sized = (a: unknown): number[] | undefined =>
      Array.isArray(a) && a.length === cells ? (a as number[]) : undefined;
    const zoom = Number.isFinite(Number(d.zoom)) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(d.zoom))) : DEFAULT_ZOOM;
    // bleed can't eat the whole grid — keep at least 1 design cell on the shorter side
    const bleed = clampInt(d.bleed, 0, Math.min(MAX_BLEED, Math.floor((Math.min(cols, rows) - 1) / 2)), 0);
    return {
      elev: d.elev.length === cells ? (d.elev as number[]) : Array<number>(cells).fill(0),
      objects: Array.isArray(d.objects) ? (d.objects as PlacedObject[]) : [],
      colorsFlat: sized(d.colorsFlat),
      colorsHi: sized(d.colorsHi),
      tiles: Array.isArray(d.tiles) ? (d.tiles as TileStamp[]) : [],
      cols,
      rows,
      zoom,
      bleed,
    };
  } catch {
    return null;
  }
}
function saveDoc(
  projectId: string,
  elev: number[],
  colorsFlat: number[],
  colorsHi: number[],
  objects: PlacedObject[],
  tiles: TileStamp[],
  cols: number,
  rows: number,
  zoom: number,
  bleed: number,
): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify({ elev, colorsFlat, colorsHi, objects, tiles, cols, rows, zoom, bleed }));
  } catch {
    /* ignore */
  }
}

/** Re-index a per-cell array when the grid is resized: keep overlapping cells, pad the rest with 0. */
function remapGrid(arr: number[], oldCols: number, oldRows: number, newCols: number, newRows: number): number[] {
  const out = Array<number>(newCols * newRows).fill(0);
  const rr = Math.min(oldRows, newRows);
  const cc = Math.min(oldCols, newCols);
  for (let r = 0; r < rr; r += 1) {
    for (let c = 0; c < cc; c += 1) out[r * newCols + c] = arr[r * oldCols + c] ?? 0;
  }
  return out;
}

/**
 * Map Studio — Phase 2: island builder with Tiny Swords autotiling + elevation.
 * You paint HEIGHT levels (water / flat / elevated). The engine autotiles the
 * grass top of every level, draws the coastline foam, and for each raised level
 * draws a shadow + a cliff face on its south edges — per the official layer stack.
 */
/** How many undo steps we keep. Snapshots are cheap (a few small arrays) but bounded. */
const HISTORY_LIMIT = 60;
/** One full editable-document snapshot — the unit the undo stack stores. */
interface DocSnapshot {
  elev: number[];
  colorFlat: number[];
  colorHi: number[];
  placed: PlacedObject[];
  stamps: TileStamp[];
  cols: number;
  rows: number;
  bleed: number;
}
export function MapBuilder({ projectId, manifest, mapFiles = [], onRefreshFiles }: MapBuilderProps) {
  // Colour palette = the `Tilemap_colorN` grass atlases ONLY, ordered by their colour number,
  // and NOTHING else. Per-cell colours and stairs store their atlas as an INDEX into this list,
  // and scene.html mirrors that index as `Tilemap_color{index+1}`. If any foreign tilemap leaks
  // in (e.g. the update-010 `Tilemap_Flat`/`Tilemap_Elevation`, which sort ahead of the colour
  // atlases by path) every index shifts and the saved map renders the wrong grass / stairs.
  // Keying on the colour number makes the list stable no matter what else the pack adds. Fall
  // back to the raw tileset list only for packs that ship no numbered colour atlases at all.
  const tilesets = useMemo(() => {
    const all = tilesetAssets(manifest);
    const colorNum = (a: PackAsset): number | null => {
      const m = /tilemap[_ ]*color\s*(\d+)/i.exec(a.name);
      return m ? parseInt(m[1]!, 10) : null;
    };
    const colors = all.filter((a) => colorNum(a) !== null).sort((x, y) => colorNum(x)! - colorNum(y)!);
    return colors.length ? colors : all;
  }, [manifest]);
  const objectAssets = useMemo(() => mapObjectAssets(manifest), [manifest]);
  const waterBg = useMemo(() => manifest.assets.find((a) => /water background/i.test(a.name)), [manifest]);
  const waterBgUrl = waterBg ? rawUrl(projectId, waterBg.path) : null;
  const shadow = useMemo(() => manifest.assets.find((a) => /shadow/i.test(a.name)), [manifest]);
  const shadowUrl = shadow ? rawUrl(projectId, shadow.path) : null;
  const foam = useMemo(
    () => manifest.assets.find((a) => /foam/i.test(a.name) && a.type === 'animation' && a.frames && a.cell),
    [manifest],
  );
  const foamUrl = foam ? rawUrl(projectId, foam.path) : null;
  const foamFrames = foam?.frames ?? 0;

  const initial = useRef<SavedDoc | null>(loadDoc(projectId));
  // Dynamic grid size + visual zoom. The old fixed constants live on as derived aliases
  // (GRID_COLS/GRID_ROWS/CELLS) so the rest of the component keeps working unchanged.
  const [cols, setCols] = useState(initial.current?.cols ?? DEFAULT_COLS);
  const [rows, setRows] = useState(initial.current?.rows ?? DEFAULT_ROWS);
  const [zoom, setZoom] = useState(initial.current?.zoom ?? DEFAULT_ZOOM);
  // Bleed ring: cols/rows are the FULL paintable grid; the DESIGN area (gold frame, what
  // the photo crops) is (cols-2·bleed)×(rows-2·bleed) centred inside it.
  const [bleed, setBleed] = useState(initial.current?.bleed ?? 0);
  const GRID_COLS = cols;
  const GRID_ROWS = rows;
  const CELLS = cols * rows;
  const [brush, setBrush] = useState<Brush>('terrain');
  const [level, setLevel] = useState(1);
  const [selColor, setSelColor] = useState<number>(LEVEL_COLOR[1] ?? 0);
  const [eraseLand, setEraseLand] = useState(false);
  const [foamOn, setFoamOn] = useState(true);
  // Editor-only alignment guides (design-boundary frame / centre cross / rule-of-thirds).
  // NOT stored in the map doc and NOT meant for the captured photo — toggle off before
  // screenshotting a map as a background. Persisted under its own localStorage key.
  const [guides, setGuides] = useState<boolean>(() => {
    try { return localStorage.getItem('od-map-studio:guides') !== '0'; } catch { return true; }
  });
  const [selObj, setSelObj] = useState<PackAsset | null>(null);
  const [elev, setElev] = useState<number[]>(() => initial.current?.elev ?? Array<number>(CELLS).fill(0));
  const [colorFlat, setColorFlat] = useState<number[]>(() => initial.current?.colorsFlat ?? Array<number>(CELLS).fill(0));
  const [colorHi, setColorHi] = useState<number[]>(() => initial.current?.colorsHi ?? Array<number>(CELLS).fill(0));
  const [placed, setPlaced] = useState<PlacedObject[]>(() => initial.current?.objects ?? []);
  const [stamps, setStamps] = useState<TileStamp[]>(() => initial.current?.tiles ?? []);
  const [stairTool, setStairTool] = useState(false);
  const painting = useRef(false);
  const [fileBusy, setFileBusy] = useState<'' | 'save' | 'load'>('');
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [mapName, setMapName] = useState('island');
  const idRef = useRef((initial.current?.objects.reduce((m, o) => Math.max(m, o.id), 0) ?? 0) + 1);
  // Object brush sub-mode: false = drop new objects, true = click-to-remove an existing one.
  const [eraseObj, setEraseObj] = useState(false);
  // Undo stack of pre-edit document snapshots (newest last). Not persisted — fresh per load.
  const [history, setHistory] = useState<DocSnapshot[]>([]);
  // A paint/stair drag is ONE undo step: the pre-stroke doc is stashed here on mousedown and
  // committed on mouseup only if `strokeChanged` flipped (so no-op clicks add no history).
  const pendingSnap = useRef<DocSnapshot | null>(null);
  const strokeChanged = useRef(false);

  const atlasForColor = (ci: number) => {
    const t = tilesets[ci] ?? tilesets[0];
    return t ? { url: rawUrl(projectId, t.path), cols: t.grid?.cols ?? 9, rows: t.grid?.rows ?? 6 } : null;
  };

  useEffect(() => {
    saveDoc(projectId, elev, colorFlat, colorHi, placed, stamps, cols, rows, zoom, bleed);
  }, [projectId, elev, colorFlat, colorHi, placed, stamps, cols, rows, zoom, bleed]);
  useEffect(() => {
    try { localStorage.setItem('od-map-studio:guides', guides ? '1' : '0'); } catch { /* ignore */ }
  }, [guides]);
  // ----- undo history -----------------------------------------------------------
  // Every discrete edit (drop/erase an object, a terrain paint stroke, a stair, Clear,
  // or a file load) pushes ONE pre-edit snapshot; the ↩ button / Ctrl+Z pops the last.
  const snapshot = (): DocSnapshot => ({ elev, colorFlat, colorHi, placed, stamps, cols, rows, bleed });
  const pushSnapshot = (snap: DocSnapshot) => {
    setHistory((h) => {
      const base = h.length >= HISTORY_LIMIT ? h.slice(h.length - HISTORY_LIMIT + 1) : h.slice();
      base.push(snap);
      return base;
    });
  };
  const pushHistory = () => pushSnapshot(snapshot());
  const beginStroke = () => {
    pendingSnap.current = snapshot();
    strokeChanged.current = false;
  };
  const undo = () => {
    if (history.length === 0) return;
    const snap = history[history.length - 1]!;
    setElev(snap.elev);
    setColorFlat(snap.colorFlat);
    setColorHi(snap.colorHi);
    setPlaced(snap.placed);
    setStamps(snap.stamps);
    setCols(snap.cols);
    setRows(snap.rows);
    setBleed(snap.bleed);
    setHistory((h) => h.slice(0, -1));
  };

  // Resize the grid: remap every per-cell layer (crop / pad with water), drop off-map objects/stairs.
  const resizeGrid = (nc: number, nr: number) => {
    const tc = clampInt(nc, MIN_DIM, MAX_DIM, cols);
    const tr = clampInt(nr, MIN_DIM, MAX_DIM, rows);
    if (tc === cols && tr === rows) return;
    pushHistory();
    setElev((p) => remapGrid(p, cols, rows, tc, tr));
    setColorFlat((p) => remapGrid(p, cols, rows, tc, tr));
    setColorHi((p) => remapGrid(p, cols, rows, tc, tr));
    setStamps((p) =>
      p
        .map((s) => {
          const c = s.i % cols;
          const r = Math.floor(s.i / cols);
          return c < tc && r < tr ? { ...s, i: r * tc + c } : null;
        })
        .filter((s): s is TileStamp => s !== null),
    );
    setPlaced((p) => p.filter((o) => (o.ax ?? o.col * CAN) <= tc * CAN && (o.ay ?? o.row * CAN) <= tr * CAN));
    setCols(tc);
    setRows(tr);
  };

  // Bleed ring stepper: add (+1) or remove (−1) ONE paintable cell ring around the design
  // area. The design size stays fixed — only the FULL grid grows/shrinks (centred) by 2 per
  // dimension, and all per-cell layers / objects / stairs shift to stay centred.
  const changeBleed = (delta: number) => {
    const d = delta > 0 ? 1 : -1;
    const b2 = bleed + d;
    if (b2 < 0 || b2 > MAX_BLEED) return;
    const nc = cols + 2 * d;
    const nr = rows + 2 * d;
    if (nc < MIN_DIM || nr < MIN_DIM || nc > MAX_DIM || nr > MAX_DIM) return;
    pushHistory();
    const pad = d; // cells added (+1) or removed (−1) on every side
    const remapRing = (a: number[]): number[] => {
      const out = Array<number>(nc * nr).fill(0);
      for (let r = 0; r < nr; r += 1) {
        for (let c = 0; c < nc; c += 1) {
          const sc = c - pad;
          const sr = r - pad;
          if (sc >= 0 && sc < cols && sr >= 0 && sr < rows) out[r * nc + c] = a[sr * cols + sc] ?? 0;
        }
      }
      return out;
    };
    setElev((p) => remapRing(p));
    setColorFlat((p) => remapRing(p));
    setColorHi((p) => remapRing(p));
    setStamps((p) =>
      p
        .map((s) => {
          const c = (s.i % cols) + pad;
          const r = Math.floor(s.i / cols) + pad;
          return c >= 0 && c < nc && r >= 0 && r < nr ? { ...s, i: r * nc + c } : null;
        })
        .filter((s): s is TileStamp => s !== null),
    );
    setPlaced((p) =>
      p
        .map((o) => {
          const ax = (o.ax ?? o.col * CAN + CAN / 2) + pad * CAN;
          const ay = (o.ay ?? (o.row + 1) * CAN) + pad * CAN;
          return { ...o, ax, ay, col: Math.floor(ax / CAN), row: Math.floor(ay / CAN) };
        })
        .filter((o) => (o.ax ?? 0) >= 0 && (o.ay ?? 0) >= 0 && (o.ax ?? 0) <= nc * CAN && (o.ay ?? 0) <= nr * CAN),
    );
    setCols(nc);
    setRows(nr);
    setBleed(b2);
  };
  // Keep a live pointer to `undo` so the one-shot keydown listener always runs the latest.
  const undoRef = useRef(undo);
  undoRef.current = undo;

  useEffect(() => {
    const up = () => {
      painting.current = false;
      // commit a terrain/stair drag as a single undo step, only if it changed anything
      const pending = pendingSnap.current;
      if (strokeChanged.current && pending) {
        pushSnapshot(pending);
      }
      strokeChanged.current = false;
      pendingSnap.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lv = (c: number, r: number): number =>
    c >= 0 && c < GRID_COLS && r >= 0 && r < GRID_ROWS ? elev[r * GRID_COLS + c] ?? 0 : 0;

  const paintCell = (i: number) => {
    if (brush !== 'terrain') return;
    const v = eraseLand ? 0 : level;
    setElev((prev) => {
      if ((prev[i] ?? 0) === v) return prev;
      strokeChanged.current = true;
      const next = prev.slice();
      next[i] = v;
      return next;
    });
    if (!eraseLand) {
      // Level 1 colours the FLAT layer; level 2+ colours the ELEVATED layer.
      // Keeping them apart means painting a plateau never recolours the flat below it.
      const apply = (prev: number[]) => {
        if ((prev[i] ?? 0) === selColor) return prev;
        strokeChanged.current = true;
        const next = prev.slice();
        next[i] = selColor;
        return next;
      };
      if (level >= 2) setColorHi(apply);
      else setColorFlat(apply);
    }
  };

  // Place a whole staircase with one click (like painting level 2): the clicked cell gets
  // the UPPER jamb, the cell below gets the LOWER jamb. The jamb side is auto-picked from
  // where the raised ground (L2+) is — plateau on the LEFT → right jamb (atlas col 3, grass
  // faces left); plateau on the RIGHT → left jamb (atlas col 0, grass faces right). Colour
  // comes from the selected grass swatch. `toggle` (a click, not a drag) removes a staircase
  // whose top already sits on the clicked cell.
  const placeStair = (i: number, toggle: boolean) => {
    const c = i % GRID_COLS;
    const r = Math.floor(i / GRID_COLS);
    if (r + 1 >= GRID_ROWS) return; // need a cell below for the lower jamb
    const below = (r + 1) * GRID_COLS + c;
    setStamps((prev) => {
      strokeChanged.current = true;
      const hasTop = prev.some((s) => s.i === i && s.row === 4 && (s.col === 0 || s.col === 3));
      if (hasTop && toggle) {
        return prev.filter((s) => !(s.i === i && s.row === 4) && !(s.i === below && s.row === 5));
      }
      const leftHigh = c - 1 >= 0 && (elev[r * GRID_COLS + (c - 1)] ?? 0) >= 2;
      const rightHigh = c + 1 < GRID_COLS && (elev[r * GRID_COLS + (c + 1)] ?? 0) >= 2;
      const jambCol = rightHigh && !leftHigh ? 0 : 3; // raised ground on the right → left jamb, else right jamb
      const rest = prev.filter((s) => s.i !== i && s.i !== below);
      return [
        ...rest,
        { i, col: jambCol, row: 4, color: selColor },
        { i: below, col: jambCol, row: 5, color: selColor },
      ];
    });
  };

  // ----- island file: read / write island.map.json so Claude can author the map from
  // the LEFT chat (Claude edits the file; the studio renders it — no second chat here). -----
  // Applies a parsed map-file object to the canvas state. Returns an error string, or null.
  const applyMapData = (raw: unknown): string | null => {
    if (!raw || typeof raw !== 'object') return 'відповідь не JSON-обʼєкт';
    const obj = raw as Record<string, unknown>;
    const terrain = obj.terrain;
    if (!Array.isArray(terrain)) return 'немає поля "terrain"';
    // the file carries its OWN grid size — adopt it (local fc/fr drive everything below)
    const fc = clampInt(obj.cols, MIN_DIM, MAX_DIM, (typeof terrain[0] === 'string' ? (terrain[0] as string).length : 0) || cols);
    const fr = clampInt(obj.rows, MIN_DIM, MAX_DIM, terrain.length || rows);
    const fcells = fc * fr;
    const nextElev = Array<number>(fcells).fill(0);
    for (let r = 0; r < fr; r += 1) {
      const rowStr = typeof terrain[r] === 'string' ? (terrain[r] as string) : '';
      for (let c = 0; c < fc; c += 1) {
        const ch = rowStr[c];
        nextElev[r * fc + c] = ch === '3' ? 3 : ch === '2' ? 2 : ch === '1' ? 1 : 0;
      }
    }
    const nColors = Math.max(1, tilesets.length);
    // Colours may be per-cell grids ("flatColors"/"hiColors") OR a single index
    // ("flatColor"/"hiColor"); a grid wins, else the single value fills the layer.
    const flatGrid = Array.isArray(obj.flatColors) ? (obj.flatColors as unknown[]) : null;
    const hiGrid = Array.isArray(obj.hiColors) ? (obj.hiColors as unknown[]) : null;
    const flatOne = clampInt(obj.flatColor, 0, nColors - 1, LEVEL_COLOR[1] ?? 0);
    const hiOne = clampInt(obj.hiColor, 0, nColors - 1, LEVEL_COLOR[2] ?? 0);
    const cellColor = (grid: unknown[] | null, fallback: number, r: number, c: number): number => {
      if (grid) {
        const row = typeof grid[r] === 'string' ? (grid[r] as string) : '';
        const n = parseInt(row[c] ?? '', 10);
        if (Number.isInteger(n)) return Math.max(0, Math.min(nColors - 1, n));
      }
      return fallback;
    };
    const nextFlat = Array<number>(fcells).fill(0);
    const nextHi = Array<number>(fcells).fill(0);
    for (let r = 0; r < fr; r += 1) {
      for (let c = 0; c < fc; c += 1) {
        const i = r * fc + c;
        if ((nextElev[i] ?? 0) >= 1) nextFlat[i] = cellColor(flatGrid, flatOne, r, c);
        if ((nextElev[i] ?? 0) >= 2) nextHi[i] = cellColor(hiGrid, hiOne, r, c);
      }
    }
    const nextPlaced: PlacedObject[] = [];
    if (Array.isArray(obj.objects)) {
      for (const o of obj.objects as Array<Record<string, unknown>>) {
        // New files store the root point x/y in canvas px; legacy files store cell col/row
        // (→ cell bottom-centre). Either way we keep the precise root anchor.
        const hasXY = Number.isFinite(Number(o?.x)) && Number.isFinite(Number(o?.y));
        const ax = hasXY ? Number(o.x) : (Math.round(Number(o?.col)) + 0.5) * CAN;
        const ay = hasXY ? Number(o.y) : (Math.round(Number(o?.row)) + 1) * CAN;
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
        if (ax < 0 || ax > fc * CAN || ay < 0 || ay > fr * CAN) continue;
        const needle = String(o?.asset ?? '').toLowerCase().trim();
        if (!needle) continue;
        const a =
          objectAssets.find((x) => x.path.toLowerCase() === needle) ??
          objectAssets.find((x) => x.name.toLowerCase().includes(needle)) ??
          objectAssets.find((x) => x.path.toLowerCase().includes(needle));
        if (!a) continue;
        nextPlaced.push({
          id: idRef.current++,
          src: rawUrl(projectId, a.path),
          natW: a.width,
          natH: a.height,
          animated: a.type === 'animation',
          frames: a.frames,
          cellW: a.cell?.w,
          cellH: a.cell?.h,
          col: Math.floor(ax / CAN),
          row: Math.floor(ay / CAN),
          ax,
          ay,
        });
      }
    }
    const nextStamps: TileStamp[] = [];
    if (Array.isArray(obj.stairs)) {
      for (const s of obj.stairs as Array<Record<string, unknown>>) {
        const col = Math.round(Number(s?.col));
        const row = Math.round(Number(s?.row));
        if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
        if (col < 0 || col >= fc || row < 0 || row + 1 >= fr) continue;
        const leftHigh = col - 1 >= 0 && (nextElev[row * fc + (col - 1)] ?? 0) >= 2;
        const rightHigh = col + 1 < fc && (nextElev[row * fc + (col + 1)] ?? 0) >= 2;
        const jambCol = rightHigh && !leftHigh ? 0 : 3;
        const stairColor = nextHi[row * fc + col] ?? hiOne;
        nextStamps.push({ i: row * fc + col, col: jambCol, row: 4, color: stairColor });
        nextStamps.push({ i: (row + 1) * fc + col, col: jambCol, row: 5, color: stairColor });
      }
    }
    pushHistory(); // a file load is one undo step — snapshot the pre-load canvas first
    setCols(fc);
    setRows(fr);
    setBleed(clampInt(obj.bleed, 0, Math.min(MAX_BLEED, Math.floor((Math.min(fc, fr) - 1) / 2)), 0));
    if (Number.isFinite(Number(obj.zoom))) setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(obj.zoom))));
    setElev(nextElev);
    setColorFlat(nextFlat);
    setColorHi(nextHi);
    setPlaced(nextPlaced);
    setStamps(nextStamps);
    return null;
  };

  // Serialise the current canvas into the compact island.map.json shape (round-trips terrain,
  // per-cell colours, objects by asset path, and stairs by their upper-jamb cell).
  const serializeMap = () => {
    const lvlChar = (v: number) => (v >= 3 ? '3' : v >= 2 ? '2' : v >= 1 ? '1' : '.');
    const terrain: string[] = [];
    const flatColors: string[] = [];
    const hiColors: string[] = [];
    for (let r = 0; r < GRID_ROWS; r += 1) {
      let tRow = '';
      let fRow = '';
      let hRow = '';
      for (let c = 0; c < GRID_COLS; c += 1) {
        const i = r * GRID_COLS + c;
        const v = elev[i] ?? 0;
        tRow += lvlChar(v);
        fRow += v >= 1 ? String((colorFlat[i] ?? 0) % 10) : '.';
        hRow += v >= 2 ? String((colorHi[i] ?? 0) % 10) : '.';
      }
      terrain.push(tRow);
      flatColors.push(fRow);
      hiColors.push(hRow);
    }
    const prefix = `/api/projects/${projectId}/raw/`;
    const pathFromSrc = (src: string): string =>
      src.startsWith(prefix) ? src.slice(prefix.length).split('/').map(decodeURIComponent).join('/') : src;
    const objects = placed.map((o) => ({
      x: Math.round(o.ax ?? o.col * CAN + CAN / 2),
      y: Math.round(o.ay ?? (o.row + 1) * CAN),
      asset: pathFromSrc(o.src),
    }));
    const stairs = stamps
      .filter((s) => s.row === 4 && (s.col === 0 || s.col === 3))
      .map((s) => ({ col: s.i % GRID_COLS, row: Math.floor(s.i / GRID_COLS) }));
    return { version: 1, cols: GRID_COLS, rows: GRID_ROWS, zoom, bleed, terrain, flatColors, hiColors, objects, stairs };
  };

  // Map name <-> file name: saving writes `<name>.map.json`; the dropdown loads any such file.
  const mapFileFor = (name: string) => `${(name.trim() || 'island').replace(/[^\p{L}\p{N} .()_\-]+/gu, '-')}.map.json`;

  const saveToFile = async () => {
    if (fileBusy) return;
    setFileBusy('save');
    setFileNote(null);
    const fileName = mapFileFor(mapName);
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, content: JSON.stringify(serializeMap(), null, 2) }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setFileNote(`💾 збережено у ${fileName}`);
      await onRefreshFiles?.();
    } catch (e) {
      setFileNote(`помилка збереження: ${(e as Error).message}`);
    } finally {
      setFileBusy('');
    }
  };

  const loadFromFile = async (fileName?: string) => {
    if (fileBusy) return;
    const name = fileName ?? mapFileFor(mapName);
    setFileBusy('load');
    setFileNote(null);
    try {
      const resp = await fetch(rawUrl(projectId, name), { cache: 'no-store' });
      if (resp.status === 404) {
        setFileNote(`нема ${name}`);
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = JSON.parse(await resp.text()) as unknown;
      const err = applyMapData(data);
      if (!err) setMapName(name.replace(/\.map\.json$/i, ''));
      setFileNote(err ? `не вдалось застосувати: ${err}` : `↻ завантажено з ${name}`);
    } catch (e) {
      setFileNote(`помилка завантаження: ${(e as Error).message}`);
    } finally {
      setFileBusy('');
    }
  };

  // Start a fresh empty map at the current size (keeps the grid; just clears + renames).
  const newMap = () => {
    pushHistory();
    setElev(Array<number>(cols * rows).fill(0));
    setColorFlat(Array<number>(cols * rows).fill(0));
    setColorHi(Array<number>(cols * rows).fill(0));
    setPlaced([]);
    setStamps([]);
    setMapName('нова-карта');
    setFileNote('Нова порожня карта — намалюй і збережи під своєю назвою');
  };

  // Coastline foam: water cells under the flat-land edge → 2.6-tile foam peeks out.
  const foamCells = useMemo(() => {
    if (!foamOn || !foamUrl) return [] as number[];
    const out: number[] = [];
    for (let r = 0; r < GRID_ROWS; r += 1) {
      for (let c = 0; c < GRID_COLS; c += 1) {
        const i = r * GRID_COLS + c;
        if ((elev[i] ?? 0) <= 0) continue;
        if (lv(c, r - 1) < 1 || lv(c + 1, r) < 1 || lv(c, r + 1) < 1 || lv(c - 1, r) < 1) out.push(i);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elev, foamOn, foamUrl]);

  // Only the LOWER stair jamb (atlas row 5 — the foot of the steps) stamped over WATER
  // gets coastline foam. The upper jamb (row 4) never does, and stairs on land (L1+) get
  // none — so waves appear only at the waterline under the bottom step.
  const stairFoamCells = useMemo(() => {
    if (!foamOn || !foamUrl) return [] as number[];
    return stamps
      .filter((s) => (s.col === 0 || s.col === 3) && s.row === 5 && (elev[s.i] ?? 0) <= 0)
      .map((s) => s.i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamps, elev, foamOn, foamUrl]);

  // Fast per-cell lookup of hand-stamped tiles.
  const stampMap = useMemo(() => {
    const m = new Map<number, TileStamp>();
    for (const s of stamps) m.set(s.i, s);
    return m;
  }, [stamps]);
  // A staircase jamb only connects its GRASS to the plateau on its grass side, so a
  // terrain cell "reaches into" a staircase ONLY when that staircase's grass faces it —
  // the cell on the staircase's OPENING side keeps its normal edge (no false merge of a
  // neighbouring block of another colour/level). A right jamb (atlas col 3) has grass on
  // its LEFT, so it connects the cell to its west; a left jamb (atlas col 0) has grass on
  // its RIGHT, connecting the cell to its east. Same grid row only.
  const isJamb = (i: number, atlasCol: number): boolean => {
    const s = stampMap.get(i);
    // ONLY the upper jamb (atlas row 4) drives adaptation — it marks the TOP of the
    // stairs (the "upper square"). The lower jamb (row 5) sits at the cliff level and
    // must NOT change a neighbouring block's design.
    return !!s && s.col === atlasCol && s.row === 4;
  };
  // east neighbour is a right-jamb → its grass faces west, toward this cell
  const stairOnEast = (c: number, r: number): boolean => c + 1 < GRID_COLS && isJamb(r * GRID_COLS + (c + 1), 3);
  // west neighbour is a left-jamb → its grass faces east, toward this cell
  const stairOnWest = (c: number, r: number): boolean => c - 1 >= 0 && isJamb(r * GRID_COLS + (c - 1), 0);

  // Stair stamp → one absolutely-positioned tile with painter's-algorithm depth (kind 4): a stair
  // behind a plateau (the plateau's higher row wins) is hidden; one in front stays visible. Level =
  // the plateau it connects to (the stamp's own cell or the cell directly above it).
  const stampTile = (s: TileStamp) => {
    const a = atlasForColor(s.color);
    if (!a) return null;
    const c = s.i % GRID_COLS;
    const r = Math.floor(s.i / GRID_COLS);
    const lvl = Math.max(1, elev[s.i] ?? 0, r > 0 ? (elev[(r - 1) * GRID_COLS + c] ?? 0) : 0);
    const z = r * 100 + lvl * 10 + 4;
    return (
      <div
        key={s.i}
        style={{ position: 'absolute', left: c * CAN, top: r * CAN, width: CAN, height: CAN, zIndex: z, ...atlasCellBg(a.url, s.col, s.row, a.cols, a.rows, CAN) }}
      />
    );
  };

  // An object's display size (dw × h). Buildings get a fixed tile WIDTH (castle 5, house/tower
  // 2, other 3); trees + their stumps scale up (green ×1.5, yellow ×1.7); the rest keep OBJ_H.
  const objectDims = (o: PlacedObject): { dw: number; h: number } => {
    const hasFrames = !!o.frames && o.frames > 1 && !!o.cellW && !!o.cellH;
    const aw = hasFrames ? o.cellW! : o.natW;
    const ah = hasFrames ? o.cellH! : o.natH;
    const prefix = `/api/projects/${projectId}/raw/`;
    const rel = o.src.startsWith(prefix) ? decodeURIComponent(o.src.slice(prefix.length)).toLowerCase() : o.src.toLowerCase();
    const fname = rel.split('/').pop() ?? rel;
    const isBuilding = rel.includes('building');
    const tilesWide = rel.includes('castle') ? 5 : rel.includes('house') || rel.includes('tower') ? 2 : 3;
    const treeMul = /(tree1|tree2|stump 1|stump 2)/.test(fname) ? 1.5 : /(tree3|tree4|stump 3|stump 4)/.test(fname) ? 1.7 : 1;
    // Rocks / stones (Water Rocks, Gold Stone) read better as small ground decor — half size.
    const rockMul = /(rock|stone)/.test(fname) ? 0.5 : 1;
    const h = isBuilding ? Math.round(tilesWide * CAN * (ah / aw)) : OBJ_H * treeMul * rockMul;
    return { dw: Math.round(h * (aw / ah)), h };
  };
  // The object's ROOT anchor in canvas pixels (bottom-centre). New drops store ax/ay (the exact
  // cursor point); legacy objects fall back to the clicked cell's bottom-centre.
  const objectRoot = (o: PlacedObject): { rx: number; ry: number } => ({
    rx: o.ax ?? o.col * CAN + CAN / 2,
    ry: o.ay ?? (o.row + 1) * CAN,
  });

  // Is the cursor inside an object's rendered box? (root bottom-centre, width dw, height h)
  const objectHit = (o: PlacedObject, px: number, py: number): boolean => {
    const { dw, h } = objectDims(o);
    const { rx, ry } = objectRoot(o);
    return px >= rx - dw / 2 && px <= rx + dw / 2 && py >= ry - h && py <= ry;
  };

  // The z-index an object renders with (painter's-algorithm depth: southern + higher level wins).
  // Mirrors the render below so "delete the object you SEE on top under the cursor" agrees with
  // the visible stack — without this, erase deleted the last-in-array box instead of the top one.
  const objectZ = (o: PlacedObject): number => {
    const { rx, ry } = objectRoot(o);
    const cc = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(rx / CAN)));
    const cr = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor((ry - 1) / CAN)));
    const lvl = elev[cr * GRID_COLS + cc] ?? 0;
    return cr * 100 + Math.max(1, lvl) * 10 + 5;
  };

  const handleGridClick = (e: MouseEvent<HTMLDivElement>) => {
    if (brush !== 'object') return;
    const rect = e.currentTarget.getBoundingClientRect();
    // CSS zoom scales the canvas box, so divide the screen-space offset back to logical px
    const px = (e.clientX - rect.left) / zoom;
    const py = (e.clientY - rect.top) / zoom;
    if (px < 0 || px >= GRID_COLS * CAN || py < 0 || py >= GRID_ROWS * CAN) return;

    // DELETE mode: click an object to remove the one drawn ON TOP under the cursor (highest
    // render z), so the block you SEE is the one that goes. Among equal z, the later-placed
    // (drawn last) wins. This is the ONLY way to remove an object now — so it must be on.
    if (eraseObj) {
      let hit = -1;
      let bestZ = -Infinity;
      for (let k = 0; k < placed.length; k += 1) {
        if (!objectHit(placed[k]!, px, py)) continue;
        const z = objectZ(placed[k]!);
        if (z >= bestZ) { bestZ = z; hit = k; }
      }
      if (hit < 0) return;
      pushHistory();
      setPlaced((prev) => prev.filter((_, idx) => idx !== hit));
      return;
    }

    // PLACE mode: ALWAYS drop a new object with its ROOT exactly under the cursor (free
    // placement, not snapped to the cell centre). Overlapping a tall neighbour's box just
    // stacks on top — it never deletes it, which was the old "hover-near eats it" bug.
    if (!selObj) return;
    const a = selObj;
    pushHistory();
    setPlaced((prev) => [
      ...prev,
      {
        id: idRef.current++,
        src: rawUrl(projectId, a.path),
        natW: a.width,
        natH: a.height,
        animated: a.type === 'animation',
        frames: a.frames,
        cellW: a.cell?.w,
        cellH: a.cell?.h,
        col: Math.floor(px / CAN),
        row: Math.floor(py / CAN),
        ax: px,
        ay: py,
      },
    ]);
  };

  const btn = (active: boolean, accent = '#6ea8fe'): CSSProperties => ({
    padding: '4px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid #2e3340',
    background: active ? accent : '#1c1f28',
    color: active ? '#0b1220' : '#e6e9ef',
    cursor: 'pointer',
  });

  // ----- build the stacked elevation layers (shadow → cliff → grass, per level) -----
  const elevLayers: ReactNode[] = [];
  for (let L = 2; L <= MAX_LEVEL; L += 1) {
    // Painter's-algorithm depth (shared by terrain, stairs, objects): z = baseRow*100 + level*10
    // + kind (shadow 0, cliff 1, grass 2, stair 4, object 5). Southern (higher row) draws on top;
    // at the same row a higher level wins. So a tall building whose ROOT is in front (south) of a
    // plateau stays visible, while one behind (north) is hidden — how it reads in-world.
    for (let r = 0; r < GRID_ROWS; r += 1) {
      for (let c = 0; c < GRID_COLS; c += 1) {
        if (lv(c, r) < L) continue;
        const a = atlasForColor(colorHi[r * GRID_COLS + c] ?? 0);
        if (!a) continue;
        // shadow: offset one tile down, 2 tiles, semi-transparent
        if (shadowUrl) {
          elevLayers.push(
            <div
              key={`sh-${L}-${c}-${r}`}
              style={{
                position: 'absolute',
                left: c * CAN + CAN / 2 - CAN,
                top: (r + 1) * CAN + CAN / 2 - CAN,
                width: CAN * 2,
                height: CAN * 2,
                opacity: 0.4,
                zIndex: r * 100 + L * 10,
                ...atlasCellBg(shadowUrl, 0, 0, 1, 1, CAN * 2),
              }}
            />,
          );
        }
        // cliff: south edge → ONE rock tile in the cell below. Always drawn, even under a
        // hand-stamped stair: the stair jamb's transparent gaps then show the rock behind
        // it — the rock must NOT vanish to the background where stairs are carved in.
        // row 4 = land-facing (sits on walkable ground); row 5 = water-facing
        // (sits on water — the coastline foam shows beneath it).
        if (lv(c, r + 1) < L) {
          // Caps follow the elevated AREA's horizontal extent (is there raised ground
          // to the side?), NOT whether the side is itself a south-edge. A staircase
          // descending on a side ALSO counts as connected ground, so the cliff continues
          // toward it: a lone right-cap (col 7 / tile 19) next to stairs on the right
          // becomes the middle (col 6 / tile 18) when the plateau also continues to the
          // left, or a left-cap (col 5 / tile 17) when it does not.
          const hasLeft = lv(c - 1, r) >= L || stairOnWest(c, r);
          const hasRight = lv(c + 1, r) >= L || stairOnEast(c, r);
          // cols: 5=left-cap, 6=middle, 7=right-cap, 8=single (isolated)
          const col = !hasLeft && !hasRight ? 8 : !hasLeft ? 5 : !hasRight ? 7 : 6;
          const cliffRow = lv(c, r + 1) < 1 ? 5 : 4;
          elevLayers.push(
            <div key={`cl-${L}-${c}-${r}`} style={{ position: 'absolute', left: c * CAN, top: (r + 1) * CAN, width: CAN, height: CAN, zIndex: (r + 1) * 100 + L * 10 + 1, ...atlasCellBg(a.url, col, cliffRow, a.cols, a.rows, CAN) }} />,
          );
        }
        // grass top of this level — elevated-ground grass block (cols 5-8). SAME
        // directional staircase adaptation as the cliff cap: grass reaches into a
        // staircase ONLY from the side its grass faces (right jamb → cell on the west,
        // left jamb → cell on the east), so a neighbouring block on the OPENING side
        // keeps its edge and does not merge. The SOUTH bit stays plain, so the edge
        // above a staircase remains a bottom-edge tile (e.g. tile 8) — grass never fills
        // in over the steps.
        let m = 0;
        if (lv(c, r - 1) >= L) m |= 1;
        if (lv(c + 1, r) >= L || stairOnEast(c, r)) m |= 2;
        if (lv(c, r + 1) >= L) m |= 4;
        if (lv(c - 1, r) >= L || stairOnWest(c, r)) m |= 8;
        const t = elevTile(m);
        elevLayers.push(
          <div key={`g-${L}-${c}-${r}`} style={{ position: 'absolute', left: c * CAN, top: r * CAN, width: CAN, height: CAN, zIndex: r * 100 + L * 10 + 2, ...atlasCellBg(a.url, t.col, t.row, a.cols, a.rows, CAN) }} />,
        );
      }
    }
  }

  return (
    <div style={{ color: '#e6e9ef', paddingBottom: 24 }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: '#1c1f28', border: '1px solid #2e3340', borderRadius: 8, padding: 2 }}>
          <button type="button" style={btn(brush === 'terrain', '#86efac')} onClick={() => setBrush('terrain')}>
            🟩 Земля
          </button>
          <button type="button" style={btn(brush === 'object', '#ffcc4d')} onClick={() => setBrush('object')}>
            🌳 Об'єкти
          </button>
        </div>
        {brush === 'terrain' ? (
          <>
            {[1, 2, 3].map((L) => (
              <button
                key={L}
                type="button"
                style={btn(level === L && !eraseLand && !stairTool, '#86efac')}
                onClick={() => {
                  setLevel(L);
                  setEraseLand(false);
                  setStairTool(false);
                  setSelColor(LEVEL_COLOR[L] ?? 0);
                }}
              >
                {LEVEL_LABEL[L]}
              </button>
            ))}
            <button type="button" style={btn(eraseLand, '#67b7ff')} onClick={() => { setEraseLand(true); setStairTool(false); }}>
              🌊 Вода
            </button>
            <button type="button" style={btn(stairTool, '#ffcc4d')} onClick={() => { setStairTool((v) => !v); setEraseLand(false); }} title="Сходи: клік біля краю плато ставить сходи (верх+низ), бік обирається сам">
              🪜 Сходи
            </button>
            <button type="button" style={btn(foamOn, '#67b7ff')} onClick={() => setFoamOn((v) => !v)} title="Авто-піна на березі">
              〰 Піна
            </button>
          </>
        ) : (
          <>
            <button type="button" style={btn(!eraseObj, '#ffcc4d')} onClick={() => setEraseObj(false)} title="Додавання: тицяй по карті, щоб поставити обраний обʼєкт">
              ➕ Додати
            </button>
            <button type="button" style={btn(eraseObj, '#ff6b6b')} onClick={() => setEraseObj(true)} title="Видалення: тицяй по обʼєкту на карті, щоб прибрати його">
              🧽 Видалити
            </button>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {eraseObj
                ? 'Режим видалення — клік по обʼєкту прибирає його'
                : selObj
                  ? `Обрано: ${selObj.name} — тицяй по карті, щоб додати`
                  : 'Обери обʼєкт нижче і тицяй по карті, щоб додати'}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={undo}
          disabled={history.length === 0}
          title="Скасувати останню дію (Ctrl+Z)"
          style={{ ...btn(false), opacity: history.length === 0 ? 0.4 : 1, cursor: history.length === 0 ? 'default' : 'pointer' }}
        >
          ↩ Назад{history.length ? ` · ${history.length}` : ''}
        </button>
        <button type="button" style={btn(false)} onClick={() => { pushHistory(); setElev(Array<number>(CELLS).fill(0)); setColorFlat(Array<number>(CELLS).fill(0)); setColorHi(Array<number>(CELLS).fill(0)); setPlaced([]); setStamps([]); }}>
          🗑 Очистити
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, opacity: 0.45 }}>💾 зберігається автоматично</span>
      </div>

      {/* map files — name + save / open any saved *.map.json / new (Claude can also write one) */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>
          🗺
          <input
            type="text"
            value={mapName}
            onChange={(e) => setMapName(e.target.value)}
            placeholder="назва карти"
            style={{ width: 150, padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #2e3340', background: '#14161c', color: '#e6e9ef' }}
          />
          <span style={{ opacity: 0.45 }}>.map.json</span>
        </label>
        <button
          type="button"
          onClick={saveToFile}
          disabled={!!fileBusy}
          style={{ padding: '6px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 0, cursor: fileBusy ? 'default' : 'pointer', background: fileBusy ? '#2e3340' : '#86efac', color: fileBusy ? '#8b93a7' : '#0b1220' }}
        >
          {fileBusy === 'save' ? '💾 Зберігаю…' : '💾 Зберегти'}
        </button>
        <select
          value=""
          disabled={!!fileBusy || mapFiles.length === 0}
          onChange={(e) => { const f = e.target.value; if (f) void loadFromFile(f); }}
          title="Відкрити збережену карту"
          style={{ padding: '6px 10px', fontSize: 13, borderRadius: 8, border: '1px solid #2e3340', background: '#1c1f28', color: '#e6e9ef', cursor: mapFiles.length ? 'pointer' : 'default' }}
        >
          <option value="">{fileBusy === 'load' ? '↻ Завантажую…' : mapFiles.length ? `📂 Відкрити (${mapFiles.length})` : '📂 нема збережених карт'}</option>
          {mapFiles.map((f) => (
            <option key={f} value={f}>{f.replace(/\.map\.json$/i, '')}</option>
          ))}
        </select>
        <button type="button" onClick={newMap} disabled={!!fileBusy} style={{ padding: '6px 12px', fontSize: 13, borderRadius: 8, border: '1px solid #2e3340', cursor: fileBusy ? 'default' : 'pointer', background: '#1c1f28', color: '#e6e9ef' }}>
          ➕ Нова
        </button>
        <span style={{ fontSize: 12, opacity: 0.7, flex: '1 1 200px' }}>
          {fileNote ?? 'Назви карту й тисни «Зберегти». Клод теж може записати *.map.json у лівому чаті.'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* palette */}
        <div style={{ flex: '0 0 auto', maxWidth: 340 }}>
          {brush === 'object' ? (
            <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Об'єкти
            </div>
          ) : null}
          {brush === 'terrain' ? (
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tilesets.map((t, idx) => {
                  const center = flatTile(15);
                  const active = selColor === idx;
                  return (
                    <button
                      key={t.path}
                      type="button"
                      title={t.name}
                      onClick={() => setSelColor(idx)}
                      style={{
                        width: PAL,
                        height: PAL,
                        padding: 0,
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: active ? '2px solid #86efac' : '1px solid #2e3340',
                        boxShadow: active ? '0 0 8px rgba(134,239,172,.7)' : 'none',
                        ...atlasCellBg(rawUrl(projectId, t.path), center.col, center.row, t.grid?.cols ?? 9, t.grid?.rows ?? 6, PAL),
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ maxHeight: GRID_ROWS * CAN, overflowY: 'auto', paddingRight: 4 }}>
              {Object.entries(manifest.categories).map(([cat, groups]) => {
                const items = groups.flatMap((gr) => gr.assets).filter((a) => objectAssets.includes(a));
                if (items.length === 0) return null;
                return (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, opacity: 0.45, margin: '4px 0' }}>{cat}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {items.map((a) => {
                        const sel = selObj?.path === a.path;
                        return (
                          <button
                            key={a.path}
                            type="button"
                            title={a.name}
                            onClick={() => { setSelObj(a); setEraseObj(false); }}
                            style={{ width: 50, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2, background: '#14161c', border: sel ? '2px solid #ffcc4d' : '1px solid #2e3340', borderRadius: 6, cursor: 'pointer' }}
                          >
                            <Sprite url={rawUrl(projectId, a.path)} animated={a.type === 'animation'} frames={a.frames} cellW={a.cell?.w} cellH={a.cell?.h} natW={a.width} natH={a.height} height={42} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* canvas */}
        <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ opacity: 0.55, textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 11 }}>Карта</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={`Ширина в клітинках (${MIN_DIM}–${MAX_DIM})`}>
              Ш
              <input
                type="number"
                min={MIN_DIM}
                max={MAX_DIM}
                key={`cols-${cols}`}
                defaultValue={cols}
                onBlur={(e) => resizeGrid(parseInt(e.target.value, 10) || cols, rows)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 48, padding: '3px 5px', fontSize: 12, borderRadius: 4, border: '1px solid #2e3340', background: '#14161c', color: '#e6e9ef', textAlign: 'center' }}
              />
            </label>
            <span style={{ opacity: 0.5 }}>×</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={`Висота в клітинках (${MIN_DIM}–${MAX_DIM})`}>
              В
              <input
                type="number"
                min={MIN_DIM}
                max={MAX_DIM}
                key={`rows-${rows}`}
                defaultValue={rows}
                onBlur={(e) => resizeGrid(cols, parseInt(e.target.value, 10) || rows)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 48, padding: '3px 5px', fontSize: 12, borderRadius: 4, border: '1px solid #2e3340', background: '#14161c', color: '#e6e9ef', textAlign: 'center' }}
              />
            </label>
            <span style={{ opacity: 0.4 }}>·</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="Зум канви (для перегляду й фото на фон)">
              🔍
              <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: 100 }} />
              <span style={{ opacity: 0.7, width: 36 }}>{Math.round(zoom * 100)}%</span>
            </label>
            <span style={{ opacity: 0.4 }}>·</span>
            <button
              type="button"
              onClick={() => setGuides((g) => !g)}
              title="Напрямні: рамка меж дизайну + центр + третини. Лише для верстки — вимкни перед фото на фон."
              style={{ padding: '4px 9px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: '1px solid #2e3340', cursor: 'pointer', background: guides ? '#ffcc4d' : '#1c1f28', color: guides ? '#0b1220' : '#e6e9ef' }}
            >
              ▦ Напрямні
            </button>
            <span style={{ opacity: 0.4 }}>·</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="Поле (припуск): кільце клітинок навколо дизайну. Малюй у ньому траву, щоб край сходився рівно — на фото воно обрізається по золотій рамці.">
              Поле
              <button type="button" onClick={() => changeBleed(-1)} disabled={bleed <= 0} style={{ width: 22, height: 22, lineHeight: '20px', textAlign: 'center', borderRadius: 4, border: '1px solid #2e3340', background: '#1c1f28', color: '#e6e9ef', cursor: bleed <= 0 ? 'default' : 'pointer', opacity: bleed <= 0 ? 0.4 : 1 }}>−</button>
              <span style={{ width: 14, textAlign: 'center' }}>{bleed}</span>
              <button type="button" onClick={() => changeBleed(1)} disabled={bleed >= MAX_BLEED || cols + 2 > MAX_DIM || rows + 2 > MAX_DIM} style={{ width: 22, height: 22, lineHeight: '20px', textAlign: 'center', borderRadius: 4, border: '1px solid #2e3340', background: '#1c1f28', color: '#e6e9ef', cursor: 'pointer', opacity: bleed >= MAX_BLEED || cols + 2 > MAX_DIM || rows + 2 > MAX_DIM ? 0.4 : 1 }}>+</button>
            </label>
            <span style={{ opacity: 0.55, fontSize: 11 }}>дизайн {cols - 2 * bleed}×{rows - 2 * bleed}</span>
          </div>
          <div
            onClick={handleGridClick}
            onMouseLeave={() => { painting.current = false; }}
            style={{
              position: 'relative',
              zoom,
              width: GRID_COLS * CAN,
              height: GRID_ROWS * CAN,
              userSelect: 'none',
              border: '1px solid #2e3340',
              cursor: brush === 'object' ? (eraseObj ? 'pointer' : 'copy') : 'crosshair',
              imageRendering: 'pixelated',
              background: waterBgUrl ? `url("${waterBgUrl}") 0 0 / ${CAN}px ${CAN}px repeat` : 'repeating-conic-gradient(#1a4a63 0% 25%, #20546e 0% 50%) 0 0 / 20px 20px',
            }}
          >
            {/* foam (z0) */}
            {foamOn && foamUrl && foamFrames > 0 ? (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
                {foamCells.map((i) => {
                  const c = i % GRID_COLS;
                  const r = Math.floor(i / GRID_COLS);
                  const delay = -(((i * 137) % (foamFrames * 90)) + 1);
                  // elevated coast drops via a cliff → push the wave down to water level
                  const off = ((elev[i] ?? 1) - 1) * CAN;
                  return (
                    <div key={i} style={{ position: 'absolute', left: c * CAN + CAN / 2 - FOAM / 2, top: r * CAN + off + CAN / 2 - FOAM / 2 }}>
                      <AnimTile url={foamUrl} frames={foamFrames} size={FOAM} delayMs={delay} />
                    </div>
                  );
                })}
                {stairFoamCells.map((i) => {
                  const c = i % GRID_COLS;
                  const r = Math.floor(i / GRID_COLS);
                  const delay = -(((i * 149) % (foamFrames * 90)) + 1);
                  // same placement as the coastline foam: centred on the lower-jamb cell.
                  // (The upper jamb gets no foam at all, so it never shows over the upper part.)
                  return (
                    <div key={`sf-${i}`} style={{ position: 'absolute', left: c * CAN + CAN / 2 - FOAM / 2, top: r * CAN + CAN / 2 - FOAM / 2 }}>
                      <AnimTile url={foamUrl} frames={foamFrames} size={FOAM} delayMs={delay} />
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* flat ground grid (z1) + paint handlers */}
            <div style={{ position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: `repeat(${GRID_COLS}, ${CAN}px)`, gridTemplateRows: `repeat(${GRID_ROWS}, ${CAN}px)` }}>
              {elev.map((k, i) => {
                const c = i % GRID_COLS;
                const r = Math.floor(i / GRID_COLS);
                let bg: CSSProperties | null = null;
                if ((k ?? 0) >= 1) {
                  const a = atlasForColor(colorFlat[i] ?? 0);
                  if (a) {
                    let m = 0;
                    if (lv(c, r - 1) >= 1) m |= 1;
                    if (lv(c + 1, r) >= 1) m |= 2;
                    if (lv(c, r + 1) >= 1) m |= 4;
                    if (lv(c - 1, r) >= 1) m |= 8;
                    // The flat (level-1) ground is the base for ALL land — always draw it,
                    // including under a raised cell, so the level-1 grass stays visible
                    // beneath the elevated block and never turns into water.
                    const t = flatTile(m);
                    bg = atlasCellBg(a.url, t.col, t.row, a.cols, a.rows, CAN);
                  }
                }
                return (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    onMouseDown={(e) => { if (brush !== 'terrain') return; e.preventDefault(); painting.current = true; beginStroke(); if (stairTool) placeStair(i, true); else paintCell(i); }}
                    onMouseEnter={() => { if (!painting.current) return; if (stairTool) placeStair(i, false); else paintCell(i); }}
                    style={{ width: CAN, height: CAN, ...(bg ?? {}) }}
                  />
                );
              })}
            </div>

            {/* elevation layers: shadow → cliff → grass per level (z10+) */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{elevLayers}</div>

            {/* stairs — wrapper has NO z-index so each stamp's own painter's z interleaves with
                terrain + objects (behind a plateau → hidden, in front → visible) */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {stamps.map(stampTile)}
            </div>

            {/* objects — wrapper has NO z-index, so each object's own z interleaves with the
                elevation: an object on level 1 sits beneath level-2/3 terrain AND their objects. */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {placed.map((o) => {
                const { dw, h } = objectDims(o);
                const { rx, ry } = objectRoot(o);
                const left = rx - dw / 2;
                const top = ry - h;
                // Depth = the elevation level the object's root stands on; higher levels (their
                // terrain AND objects) draw over lower ones, and southern objects over northern.
                // Same formula as objectZ() so erase-picks-topmost agrees with this visible stack.
                const z = objectZ(o);
                return (
                  <div key={o.id} style={{ position: 'absolute', left, top, zIndex: z, filter: 'drop-shadow(0 3px 2px rgba(0,0,0,.5))' }}>
                    <Sprite url={o.src} animated={o.animated} frames={o.frames} cellW={o.cellW} cellH={o.cellH} natW={o.natW} natH={o.natH} height={h} />
                  </div>
                );
              })}
            </div>

            {/* alignment guides — editor only, sits above everything; toggle off before a photo.
                The overlay box is the DESIGN area (inset by the bleed ring), so the gold frame
                marks exactly where the photo crops and the thirds/centre track the design. */}
            {guides ? (
              <div style={{ position: 'absolute', left: bleed * CAN, top: bleed * CAN, right: bleed * CAN, bottom: bleed * CAN, zIndex: 99999, pointerEvents: 'none' }}>
                {/* rule-of-thirds — subtle white */}
                {[1, 2].map((n) => (
                  <div key={`gtv${n}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(n / 3) * 100}%`, width: 0, borderLeft: '1px dashed rgba(255,255,255,.25)' }} />
                ))}
                {[1, 2].map((n) => (
                  <div key={`gth${n}`} style={{ position: 'absolute', left: 0, right: 0, top: `${(n / 3) * 100}%`, height: 0, borderTop: '1px dashed rgba(255,255,255,.25)' }} />
                ))}
                {/* centre cross — blue */}
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 0, borderLeft: '1px dashed rgba(91,156,255,.6)' }} />
                <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 0, borderTop: '1px dashed rgba(91,156,255,.6)' }} />
                {/* design-boundary frame — where the photo crops (gold) */}
                <div style={{ position: 'absolute', inset: 0, border: '2px dashed rgba(255,204,77,.95)' }} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
