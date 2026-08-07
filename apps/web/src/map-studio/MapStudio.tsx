import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildPackManifest,
  type PackAsset,
  type PackManifest,
  type RawImageFile,
} from './asset-manifest';
import { MapBuilder } from './MapBuilder';

/** Minimal structural shape of a project file — accepts ProjectFile[]. */
interface MapStudioFile {
  name: string;
  kind?: string;
}

interface MapStudioProps {
  projectId: string;
  files: readonly MapStudioFile[];
  onUpload: () => void;
  onRefreshFiles: () => Promise<void> | void;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

function rawUrl(projectId: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${projectId}/raw/${encoded}`;
}

function measureImage(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Load every image (bounded concurrency) just to read its pixel dimensions. */
async function measureAll(projectId: string, paths: readonly string[]): Promise<RawImageFile[]> {
  const out: RawImageFile[] = [];
  const queue = paths.slice();
  const workers = Array.from({ length: 12 }, async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) break;
      const dim = await measureImage(rawUrl(projectId, p));
      if (dim && dim.w > 0 && dim.h > 0) out.push({ path: p, width: dim.w, height: dim.h });
    }
  });
  await Promise.all(workers);
  return out;
}

const TYPE_LABEL: Record<PackAsset['type'], string> = {
  animation: 'анімація',
  sprite: 'спрайт',
  tileset: 'тайлсет',
  'unit-sheet': 'сітка',
  icon: 'іконка',
  avatar: 'аватар',
  button: 'кнопка',
  panel9: '9-slice',
  bar: 'смужка',
  image: 'картинка',
};

/** Shows one frame of a single-row strip; loops via Web Animations API if loop. */
function FrameSprite(props: { url: string; frames: number; cellW: number; cellH: number; box: number; loop: boolean }) {
  const { url, frames, cellW, cellH, box, loop } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const scale = box / cellH;
  const frameW = Math.round(cellW * scale);
  const stripW = frameW * Math.max(1, frames);
  useEffect(() => {
    if (!loop) return;
    const el = ref.current;
    if (!el || frames < 1) return;
    const anim = el.animate(
      [{ backgroundPosition: '0px 0px' }, { backgroundPosition: `-${stripW}px 0px` }],
      { duration: Math.max(500, frames * 110), easing: `steps(${frames})`, iterations: Infinity },
    );
    return () => anim.cancel();
  }, [url, frames, stripW, loop]);
  return (
    <div
      ref={ref}
      style={{
        width: frameW,
        height: box,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${stripW}px ${box}px`,
        backgroundPosition: '0px 0px',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/**
 * Multi-row sprite sheet (Update-010 unit/troop grids): each ROW is a separate
 * action and each row's columns are its frames. A plain <img> would squash the
 * whole grid into the thumbnail; instead we show ONE cell and loop the FIRST
 * row (the idle pose) like a single-row strip — the background is sized to the
 * full sheet so only row 0 is visible and we step the X position across it.
 */
function SheetSprite(props: { url: string; cols: number; rows: number; cellW: number; cellH: number; box: number }) {
  const { url, cols, rows, cellW, cellH, box } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const scale = box / cellH;
  const frameW = Math.round(cellW * scale);
  const sheetW = frameW * Math.max(1, cols);
  const sheetH = box * Math.max(1, rows);
  useEffect(() => {
    const el = ref.current;
    if (!el || cols < 2) return; // a single column has nothing to animate
    const anim = el.animate(
      [{ backgroundPosition: '0px 0px' }, { backgroundPosition: `-${sheetW}px 0px` }],
      { duration: Math.max(500, cols * 120), easing: `steps(${cols})`, iterations: Infinity },
    );
    return () => anim.cancel();
  }, [url, cols, sheetW]);
  return (
    <div
      ref={ref}
      style={{
        width: frameW,
        height: box,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${sheetW}px ${sheetH}px`,
        backgroundPosition: '0px 0px', // top-left cell = row 0, col 0
        imageRendering: 'pixelated',
      }}
    />
  );
}

function AssetThumb({ projectId, asset }: { projectId: string; asset: PackAsset }) {
  const url = rawUrl(projectId, asset.path);
  const box = 64;
  if ((asset.type === 'animation' || asset.type === 'sprite') && asset.frames && asset.cell) {
    return (
      <FrameSprite
        url={url}
        frames={asset.frames}
        cellW={asset.cell.w}
        cellH={asset.cell.h}
        box={box}
        loop={asset.type === 'animation'}
      />
    );
  }
  if (asset.type === 'unit-sheet' && asset.grid && asset.cell) {
    return (
      <SheetSprite
        url={url}
        cols={asset.grid.cols}
        rows={asset.grid.rows}
        cellW={asset.cell.w}
        cellH={asset.cell.h}
        box={box}
      />
    );
  }
  return (
    <img
      src={url}
      alt={asset.name}
      loading="lazy"
      style={{ maxWidth: box, maxHeight: box, imageRendering: 'pixelated', objectFit: 'contain' }}
    />
  );
}

/**
 * Map Studio — Phase 1 surface: the asset library.
 * Runs the asset-manifest engine over every uploaded image and shows the pack
 * grouped by folder, animations playing live. (Phase 2 adds the tile-map canvas.)
 */
export function MapStudio({ projectId, files, onUpload, onRefreshFiles }: MapStudioProps) {
  const imagePaths = useMemo(
    () => files.filter((f) => f.kind === 'image' || IMAGE_RE.test(f.name)).map((f) => f.name),
    [files],
  );
  const imageKey = imagePaths.join('|');
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'library' | 'map'>('library');

  useEffect(() => {
    let cancelled = false;
    if (imagePaths.length === 0) {
      setManifest(null);
      return;
    }
    setBusy(true);
    void measureAll(projectId, imagePaths).then((raw) => {
      if (cancelled) return;
      setManifest(buildPackManifest(raw));
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
    // imageKey captures the path set; measuring depends only on it + projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, imageKey]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '16px 18px', color: '#e6e9ef', background: '#161922' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🗺️ Майстерня ассетів</h2>
        <div style={{ display: 'flex', gap: 4, background: '#1c1f28', border: '1px solid #2e3340', borderRadius: 8, padding: 2 }}>
          <button
            type="button"
            onClick={() => setView('library')}
            style={{ padding: '4px 10px', borderRadius: 6, border: 0, cursor: 'pointer', fontSize: 12, background: view === 'library' ? '#6ea8fe' : 'transparent', color: view === 'library' ? '#0b1220' : '#e6e9ef' }}
          >
            Бібліотека
          </button>
          <button
            type="button"
            onClick={() => setView('map')}
            style={{ padding: '4px 10px', borderRadius: 6, border: 0, cursor: 'pointer', fontSize: 12, background: view === 'map' ? '#6ea8fe' : 'transparent', color: view === 'map' ? '#0b1220' : '#e6e9ef' }}
          >
            Будувати карту
          </button>
        </div>
        {manifest ? (
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {manifest.count} картинок ·{' '}
            {Object.entries(manifest.typeCounts)
              .filter(([, n]) => n > 0)
              .map(([type, n]) => `${TYPE_LABEL[type as PackAsset['type']] ?? type}: ${n}`)
              .join(' · ')}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onUpload}>
          ⬆ Завантажити пак
        </button>
        <button type="button" className="btn" onClick={() => void onRefreshFiles()} title="Оновити">
          ↻
        </button>
      </div>

      {view === 'map' ? (
        manifest ? (
          <MapBuilder
            projectId={projectId}
            manifest={manifest}
            mapFiles={files.filter((f) => /\.map\.json$/i.test(f.name)).map((f) => f.name)}
            onRefreshFiles={onRefreshFiles}
          />
        ) : (
          <div style={{ opacity: 0.7, padding: '40px 0' }}>
            Спершу завантаж пак із картинками — і зможеш будувати карту.
          </div>
        )
      ) : busy ? (
        <div style={{ opacity: 0.7, padding: '40px 0' }}>Аналізую {imagePaths.length} картинок…</div>
      ) : !manifest ? (
        <div style={{ opacity: 0.7, padding: '40px 0', maxWidth: 460, lineHeight: 1.5 }}>
          Тут поки порожньо. Натисни «Завантажити пак» і додай картинки (PNG) — движок сам
          розкладе їх по типах (анімації, тайлсети, іконки, кнопки…) і згрупує за папками.
        </div>
      ) : (
        <div>
          {Object.entries(manifest.categories).map(([category, groups]) => (
            <section key={category} style={{ marginBottom: 22 }}>
              <h3 style={{ fontSize: 15, margin: '0 0 8px', color: '#ffcc4d' }}>{category}</h3>
              {groups.map((group) => (
                <div key={group.label} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '.05em',
                      opacity: 0.55,
                      margin: '0 0 6px',
                    }}
                  >
                    {group.label}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {group.assets.map((asset) => (
                      <div
                        key={asset.path}
                        title={`${asset.name}  ${asset.width}×${asset.height}${asset.frames ? `  (${asset.frames}f)` : ''}`}
                        style={{
                          width: 92,
                          background: '#1c1f28',
                          border: '1px solid #2e3340',
                          borderRadius: 8,
                          padding: 6,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <div style={{ height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <AssetThumb projectId={projectId} asset={asset} />
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            opacity: 0.85,
                            textAlign: 'center',
                            wordBreak: 'break-word',
                            lineHeight: 1.15,
                          }}
                        >
                          {asset.name}
                        </div>
                        <div style={{ fontSize: 9, opacity: 0.55 }}>
                          {TYPE_LABEL[asset.type] ?? asset.type}
                          {asset.frames ? ` · ${asset.frames}f` : ''}
                          {asset.grid ? ` · ${asset.grid.cols}×${asset.grid.rows}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
