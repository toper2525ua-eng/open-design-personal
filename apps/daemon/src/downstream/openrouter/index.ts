import type { DownstreamMediaRenderer } from '../api.js';

import { renderOpenRouterImage, renderOpenRouterVideo } from './provider.js';

export const OPENROUTER_RENDERERS: Record<string, DownstreamMediaRenderer> = {
  'openrouter:image': renderOpenRouterImage,
  'openrouter:video': renderOpenRouterVideo,
};

export { OPENROUTER_PROVIDER, OPENROUTER_IMAGE_MODELS, OPENROUTER_VIDEO_MODELS } from './models.js';
export { OPENROUTER_ENV_KEYS } from './env-keys.js';
