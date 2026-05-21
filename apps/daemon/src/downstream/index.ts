// Downstream-only extensions barrel.
//
// Files under `apps/daemon/src/downstream/` are owned by this fork and
// must not be modified by upstream merges. Upstream files keep their
// integration points to a single import + spread, which means weekly
// rebases against upstream/main have almost no surface to conflict on.
//
// Conventions:
//   * Add a new provider under `downstream/<name>/`, exporting:
//       - renderer functions registered into the provider:surface map
//       - MEDIA_PROVIDER + MediaModel entries
//       - env-key mapping
//   * Add a new HTTP route bundle under `downstream/<feature>/`, exporting
//     a `register*Routes(app)` function, then call it from
//     `registerDownstreamRoutes` below.
//   * Re-export everything through this barrel.
//   * Upstream `media.ts`, `media-models.ts`, `media-config.ts`,
//     `server.ts` consume this barrel via the named exports below.

import type { Express } from 'express';

import type { DownstreamMediaRenderer } from './api.js';

import {
  OPENROUTER_RENDERERS,
  OPENROUTER_PROVIDER,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_VIDEO_MODELS,
  OPENROUTER_ENV_KEYS,
} from './openrouter/index.js';

import { registerTgWebRoutes } from './tg-web/routes.js';
import { registerObsidianRoutes } from './obsidian/routes.js';

import type { MediaModel, MediaProvider } from '../media-models.js';

export const downstreamMediaRenderers: Record<string, DownstreamMediaRenderer> = {
  ...OPENROUTER_RENDERERS,
};

export const downstreamProviders: MediaProvider[] = [
  OPENROUTER_PROVIDER,
];

export const downstreamImageModels: MediaModel[] = [
  ...OPENROUTER_IMAGE_MODELS,
];

export const downstreamVideoModels: MediaModel[] = [
  ...OPENROUTER_VIDEO_MODELS,
];

export const downstreamEnvKeys: Record<string, string[]> = {
  ...OPENROUTER_ENV_KEYS,
};

// Registers every downstream HTTP route bundle on the daemon's Express
// app. Called once from `server.ts:startServer()`.
export function registerDownstreamRoutes(app: Express): void {
  registerTgWebRoutes(app);
  registerObsidianRoutes(app);
}

export type {
  DownstreamMediaContext,
  DownstreamMediaRenderer,
  DownstreamMediaSurface,
  DownstreamProgressFn,
  DownstreamProviderConfig,
  DownstreamRenderResult,
} from './api.js';

