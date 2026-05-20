// Downstream-only extensions barrel (web side).
//
// Files under `apps/web/src/downstream/` are owned by this fork and must
// not be modified by upstream merges. Upstream files keep their
// integration points to a single import + spread.

import type { MediaModel, MediaProvider } from '../media/models';

import {
  OPENROUTER_PROVIDER_META,
  OPENROUTER_IMAGE_MODELS_WEB,
  OPENROUTER_VIDEO_MODELS_WEB,
} from './openrouter/index';

export const downstreamProvidersWeb: MediaProvider[] = [
  OPENROUTER_PROVIDER_META,
];

export const downstreamImageModelsWeb: MediaModel[] = [
  ...OPENROUTER_IMAGE_MODELS_WEB,
];

export const downstreamVideoModelsWeb: MediaModel[] = [
  ...OPENROUTER_VIDEO_MODELS_WEB,
];
