// Public contract for downstream media-provider plugins.
//
// Files under `apps/daemon/src/downstream/` register additional media
// providers without touching the upstream provider implementations in
// `media.ts`. The registry is consumed by the dispatch loop in
// `generateMedia()` via a single import.
//
// Keeping this contract narrow (only the fields each downstream provider
// actually reads) means the upstream MediaContext can grow new fields
// without churning downstream provider files.

export type DownstreamProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type DownstreamProgressFn = (message: string) => void;

export type DownstreamRenderResult = {
  bytes: Buffer;
  providerNote: string;
  suggestedExt?: string;
};

export type DownstreamMediaSurface = 'image' | 'video' | 'audio';

// Structural subset of `MediaContext` (in media.ts) — downstream
// renderers see only these fields. Upstream may pass a full MediaContext;
// TypeScript accepts it because every field below is present there.
export type DownstreamMediaContext = {
  surface: DownstreamMediaSurface;
  model: string;
  prompt: string;
  aspect: string | undefined;
  length: number | undefined;
  /**
   * Resolved reference image for image-to-video / reference-to-video and
   * image-edit flows. Present only when the caller passed `--image`;
   * null/undefined otherwise. Structural subset of the upstream
   * MediaContext.imageRef so the dispatcher can hand a full MediaContext
   * to a downstream renderer without a cast.
   */
  imageRef?: { dataUrl: string; mime?: string } | null;
};

export type DownstreamMediaRenderer = (
  ctx: DownstreamMediaContext,
  credentials: DownstreamProviderConfig,
  onProgress?: DownstreamProgressFn,
) => Promise<DownstreamRenderResult>;
