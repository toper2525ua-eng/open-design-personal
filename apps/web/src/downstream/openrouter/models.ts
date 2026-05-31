// OpenRouter provider + model registry entries (web side).
// Spread into upstream MEDIA_PROVIDERS / IMAGE_MODELS / VIDEO_MODELS
// arrays in media/models.ts via the downstream barrel.

import type { MediaModel, MediaProvider } from '../../media/models';

export const OPENROUTER_PROVIDER_META: MediaProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  hint: 'OpenAI-compatible gateway: nano-banana-2 (image) + Veo 3.1 / Seedance 2.0 (video)',
  integrated: true,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  docsUrl: 'https://openrouter.ai/keys',
  supportsCustomModel: true,
};

export const OPENROUTER_IMAGE_MODELS_WEB: MediaModel[] = [
  {
    id: 'openrouter-nano-banana-2',
    label: 'nano-banana-2 (OpenRouter)',
    hint: 'Google · routed via OpenRouter',
    provider: 'openrouter',
    caps: ['t2i'],
  },
];

export const OPENROUTER_VIDEO_MODELS_WEB: MediaModel[] = [
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
  {
    id: 'openrouter-seedance-2.0',
    label: 'seedance-2.0 (OpenRouter)',
    hint: 'ByteDance Seedance 2.0 · routed via OpenRouter; t2v + i2v + reference + audio',
    provider: 'openrouter',
    caps: ['t2v', 'i2v', 'audio'],
  },
  {
    id: 'openrouter-seedance-2.0-fast',
    label: 'seedance-2.0-fast (OpenRouter)',
    hint: 'Seedance 2.0 Fast · cheaper/faster variant',
    provider: 'openrouter',
    caps: ['t2v', 'i2v', 'audio'],
  },
];
