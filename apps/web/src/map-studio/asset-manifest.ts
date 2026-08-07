/**
 * Map Studio — asset manifest engine.
 *
 * Pure, dependency-free logic that turns a flat list of uploaded image files
 * (path + pixel dimensions) into a structured, grouped manifest the UI and the
 * agent can build maps/screens from.
 *
 * It is the "read the whole pack, group by folder, figure out what each file is"
 * brain. Heuristics are tuned for sprite packs like Tiny Swords (Pixel Frog) but
 * are folder-name + dimension based, so they generalise; every field can be
 * overridden later by a stored manifest the user edits.
 *
 * Kept framework-free on purpose (no React/daemon imports) so it can be unit
 * tested and, later, reused server-side for the Claude-assisted flow.
 */

/** What a single asset image is, for the purposes of building maps/screens. */
export type AssetType =
  | 'animation' // single-row horizontal sprite strip that LOOPS (characters, effects)
  | 'sprite' // single-row strip shown STATIC at frame 0 (trees, bushes, variants)
  | 'tileset' // atlas of equal tiles → paint terrain by square
  | 'unit-sheet' // multi-row sprite grid (one frame per cell)
  | 'icon' // small square single icon
  | 'avatar' // portrait/avatar thumbnail
  | 'button' // single complete button graphic
  | 'panel9' // 9-slice panel/banner/paper (scales via border-image)
  | 'bar' // horizontal 9-slice bar (left cap / fill / right cap)
  | 'image'; // anything else — use as-is

export interface PackAsset {
  /** Path relative to the pack root, POSIX separators. */
  path: string;
  /** File name (last path segment). */
  name: string;
  /** Folder segments above the file, e.g. ['Units', 'Blue Units', 'Warrior']. */
  group: string[];
  width: number;
  height: number;
  type: AssetType;
  /** animation / unit-sheet: number of frames detected. */
  frames?: number;
  /** animation / unit-sheet / tileset: single cell size in px. */
  cell?: { w: number; h: number };
  /** tileset / unit-sheet: grid dimensions in cells. */
  grid?: { cols: number; rows: number };
  /** panel9 / bar: suggested border-image slice inset in px (override as needed). */
  slice?: number;
  /** How sure the classifier is (heuristic vs strong signal). */
  confidence: 'high' | 'medium' | 'low';
}

export interface PackGroup {
  /** Joined folder path, e.g. 'Units / Blue Units / Warrior'. */
  label: string;
  /** Raw folder segments. */
  path: string[];
  assets: PackAsset[];
}

export interface PackManifest {
  version: number;
  /** Total image count. */
  count: number;
  assets: PackAsset[];
  /** Assets bucketed by their top-level category (first folder segment). */
  categories: Record<string, PackGroup[]>;
  /** Counts per AssetType, for a quick overview. */
  typeCounts: Record<AssetType, number>;
}

export const MAP_MANIFEST_VERSION = 1;
/** Default tile size for terrain atlases (Tiny Swords tilemaps are 64px). */
export const DEFAULT_TILE = 64;

export interface RawImageFile {
  /** Path relative to the pack root (POSIX or Windows separators accepted). */
  path: string;
  width: number;
  height: number;
}

const lc = (s: string) => s.toLowerCase();

function splitPath(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.');
}

/** Does any folder segment (case-insensitive) contain the needle? */
function folderHas(segments: string[], needle: string): boolean {
  const n = lc(needle);
  return segments.some((seg) => lc(seg).includes(n));
}

/** Integer divisibility helper that also rejects the trivial 1-frame case. */
function evenlyDivides(total: number, unit: number): boolean {
  return unit > 0 && total % unit === 0;
}

/**
 * Classify one image from its path + dimensions.
 * Order matters: most specific folder signals first, dimension heuristics last.
 */
export function classifyAsset(file: RawImageFile): PackAsset {
  const segments = splitPath(file.path);
  const name = segments[segments.length - 1] ?? file.path;
  const group = segments.slice(0, -1);
  const w = file.width;
  const h = file.height;
  const nameLc = lc(name);

  const base: PackAsset = {
    path: segments.join('/'),
    name,
    group,
    width: w,
    height: h,
    type: 'image',
    confidence: 'low',
  };

  // --- strong folder-name signals ----------------------------------------
  if (folderHas(group, 'human avatars') || nameLc.startsWith('avatars_')) {
    return { ...base, type: 'avatar', confidence: 'high' };
  }
  if (folderHas(group, 'icons')) {
    return { ...base, type: 'icon', confidence: 'high' };
  }
  if (folderHas(group, 'bars')) {
    return { ...base, type: 'bar', slice: Math.round(Math.min(w, h) / 2), confidence: 'high' };
  }
  if (folderHas(group, 'buttons')) {
    // Big* buttons are 9-slice templates; Small/Tiny are single complete buttons.
    const isBig = nameLc.includes('big');
    return isBig
      ? { ...base, type: 'panel9', slice: Math.round(w / 3), confidence: 'high' }
      : { ...base, type: 'button', confidence: 'high' };
  }
  if (
    folderHas(group, 'banners') ||
    folderHas(group, 'papers') ||
    folderHas(group, 'wood table') ||
    nameLc.includes('banner') ||
    nameLc.includes('paper') ||
    nameLc.includes('woodtable')
  ) {
    return { ...base, type: 'panel9', slice: Math.round(Math.min(w, h) / 3), confidence: 'medium' };
  }

  // --- tilesets / atlases -------------------------------------------------
  // Explicit tilemap atlases, or a clean 64-grid that is not a thin strip
  // and not a single graphic (shadow/background/foam) that merely happens to
  // divide evenly by 64.
  const looksLikeTileGrid =
    evenlyDivides(w, DEFAULT_TILE) &&
    evenlyDivides(h, DEFAULT_TILE) &&
    w >= DEFAULT_TILE * 2 &&
    h >= DEFAULT_TILE * 2;
  const thinStrip = h <= 320 && w / h >= 4;
  const singleGraphic =
    nameLc.includes('shadow') || nameLc.includes('background') || nameLc.includes('foam');
  if (
    nameLc.includes('tilemap') ||
    (folderHas(group, 'tileset') && looksLikeTileGrid && !thinStrip && !singleGraphic && w / h < 3)
  ) {
    return {
      ...base,
      type: 'tileset',
      cell: { w: DEFAULT_TILE, h: DEFAULT_TILE },
      grid: { cols: w / DEFAULT_TILE, rows: h / DEFAULT_TILE },
      confidence: 'high',
    };
  }

  // --- single-row sprite strips (characters, trees, sheep, fx) -----------
  // The frame is usually SQUARE (Tiny Swords uses 64/128/192/320), but tall
  // content (e.g. 256px pine trees) is packed in NARROWER frames, so the frame
  // width is NOT always the height — using height-as-width slides the strip
  // ("moves forward") and crops frames. Pick the right standard frame width.
  const isUnitFolder = folderHas(group, 'units') || folderHas(group, 'troops');
  const SQUARE_FRAMES = [320, 192, 128, 64];
  let frameWidth = 0;
  if (h <= 320 && w >= h * 2) {
    if (SQUARE_FRAMES.includes(h) && evenlyDivides(w, h)) {
      frameWidth = h; // standard square frames (units, 192-tall trees, sheep…)
    } else if (evenlyDivides(w, h)) {
      // tall content (e.g. 256) packed in narrower standard frames (192)
      frameWidth = SQUARE_FRAMES.find((s) => s < h && evenlyDivides(w, s) && w / s >= 2) ?? h;
    }
    // else: width is not a clean multiple of any frame size → not a strip (e.g. a single wide cloud)
  }
  if (frameWidth > 0) {
    return {
      ...base,
      type: 'animation',
      frames: w / frameWidth,
      cell: { w: frameWidth, h },
      confidence: 'high',
    };
  }

  // --- multi-row sprite grid (Update 010 style sheets) -------------------
  const FRAME = 192;
  if (isUnitFolder && evenlyDivides(w, FRAME) && evenlyDivides(h, FRAME) && h > FRAME) {
    return {
      ...base,
      type: 'unit-sheet',
      cell: { w: FRAME, h: FRAME },
      grid: { cols: w / FRAME, rows: h / FRAME },
      frames: (w / FRAME) * (h / FRAME),
      confidence: 'medium',
    };
  }

  // --- small square singletons → icon-like -------------------------------
  if (w === h && w <= 128) {
    return { ...base, type: 'icon', confidence: 'low' };
  }

  return base;
}

/** Build the full grouped manifest from a list of image files. */
export function buildPackManifest(files: readonly RawImageFile[]): PackManifest {
  const assets = files
    .map((f) => classifyAsset(f))
    .sort((a, b) => a.path.localeCompare(b.path));

  const categories: Record<string, PackGroup[]> = {};
  const groupIndex = new Map<string, PackGroup>();

  const emptyTypeCounts = (): Record<AssetType, number> => ({
    animation: 0,
    sprite: 0,
    tileset: 0,
    'unit-sheet': 0,
    icon: 0,
    avatar: 0,
    button: 0,
    panel9: 0,
    bar: 0,
    image: 0,
  });
  const typeCounts = emptyTypeCounts();

  for (const asset of assets) {
    typeCounts[asset.type] += 1;
    const top = asset.group[0] ?? '(root)';
    const key = asset.group.join('/') || '(root)';
    let grp = groupIndex.get(key);
    if (!grp) {
      grp = { label: asset.group.join(' / ') || '(root)', path: asset.group.slice(), assets: [] };
      groupIndex.set(key, grp);
      (categories[top] ??= []).push(grp);
    }
    grp.assets.push(asset);
  }

  for (const groups of Object.values(categories)) {
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }

  return {
    version: MAP_MANIFEST_VERSION,
    count: assets.length,
    assets,
    categories,
    typeCounts,
  };
}

/** Assets you can paint as terrain (atlases sliced into tiles). */
export function tilesetAssets(manifest: PackManifest): PackAsset[] {
  return manifest.assets.filter((a) => a.type === 'tileset');
}

/** Assets you can drop as sprites on a map (any non-tile, non-UI image). */
export function placeableAssets(manifest: PackManifest): PackAsset[] {
  return manifest.assets.filter(
    (a) =>
      a.type === 'animation' ||
      a.type === 'sprite' ||
      a.type === 'unit-sheet' ||
      a.type === 'image',
  );
}

/**
 * Map-building objects: placeables for LOCATIONS only — buildings, trees,
 * rocks, bushes, resources, decor. Excludes playable characters/units and
 * combat FX (those belong to gameplay, not to map building).
 */
export function mapObjectAssets(manifest: PackManifest): PackAsset[] {
  return placeableAssets(manifest).filter(
    (a) => !/(unit|troop|effect|particle)/.test(a.group.join('/').toLowerCase()),
  );
}
