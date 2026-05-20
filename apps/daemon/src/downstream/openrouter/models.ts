// OpenRouter provider + model registry entries (daemon side).
// Spread into upstream MEDIA_PROVIDERS / IMAGE_MODELS / VIDEO_MODELS
// arrays in media-models.ts via the downstream barrel.

import type { MediaModel, MediaProvider } from '../../media-models.js';

export const OPENROUTER_PROVIDER: MediaProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  hint: 'OpenAI-compatible gateway: nano-banana-2 (image) + Veo 3.1 (video)',
  integrated: true,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  supportsCustomModel: true,
};

export const OPENROUTER_IMAGE_MODELS: MediaModel[] = [
  {
    id: 'openrouter-nano-banana-2',
    label: 'nano-banana-2 (OpenRouter)',
    hint: 'Google · routed via OpenRouter',
    provider: 'openrouter',
    caps: ['t2i'],
  },
];

export const OPENROUTER_VIDEO_MODELS: MediaModel[] = [
  {
    id: 'openrouter-veo-3.1',
    label: 'veo-3.1 (OpenRouter)',
    hint: 'Google Veo 3.1 · routed via OpenRouter; t2v + audio',
    provider: 'openrouter',
    caps: ['t2v', 'audio'],
  },
  {
    id: 'openrouter-veo-3.1-fast',
    label: 'veo-3.1-fast (OpenRouter)',
    hint: 'Veo 3.1 Fast · cheaper variant',
    provider: 'openrouter',
    caps: ['t2v', 'audio'],
  },
];
