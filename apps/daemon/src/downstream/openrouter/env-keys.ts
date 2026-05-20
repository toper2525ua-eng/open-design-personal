// Env-key mapping for OpenRouter. Spread into upstream ENV_KEYS in
// media-config.ts via the downstream barrel.

export const OPENROUTER_ENV_KEYS: Record<string, string[]> = {
  openrouter: ['OD_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
};
