/**
 * Anthropic model discovery via `GET /v1/models`.
 *
 * The cache is module-level so every ClaudeProvider instance (the factory
 * creates a new one per call) sees the same discovered list.
 */

import { createLogger } from '@aboardai/utils';

const logger = createLogger('ClaudeModelDiscovery');

/** Cache duration for dynamic model fetching (30 minutes) */
export const CLAUDE_MODEL_CACHE_DURATION_MS = 30 * 60 * 1000;

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface DiscoveredClaudeModel {
  id: string;
  displayName: string;
}

/** Parse an Anthropic `GET /v1/models` payload into `{ id, displayName }` entries. */
export function parseAnthropicModelsResponse(payload: unknown): DiscoveredClaudeModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const models: DiscoveredClaudeModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof record.display_name === 'string' && record.display_name.trim()
        ? record.display_name.trim()
        : id;
    models.push({ id, displayName });
  }
  return models;
}

/** Fetch the model list from the Anthropic API. Throws on HTTP or network failure. */
export async function fetchClaudeModelsFromApi(
  apiKey: string,
  baseUrl: string = process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL
): Promise<DiscoveredClaudeModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`;
  const response = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Anthropic models request failed: HTTP ${response.status}`);
  }
  return parseAnthropicModelsResponse(await response.json());
}

let cachedModels: DiscoveredClaudeModel[] | null = null;
let cacheExpiry = 0;
let inFlight: Promise<DiscoveredClaudeModel[]> | null = null;

export function getCachedClaudeModels(): DiscoveredClaudeModel[] | null {
  return cachedModels;
}

export function hasCachedClaudeModels(): boolean {
  return cachedModels !== null && cachedModels.length > 0;
}

export function isClaudeModelCacheStale(): boolean {
  return Date.now() >= cacheExpiry;
}

export function clearClaudeModelCache(): void {
  cachedModels = null;
  cacheExpiry = 0;
  logger.debug('Cleared Claude model cache');
}

/**
 * Refresh the cache from the API. Without an API key (Claude Max / OAuth users)
 * discovery is skipped and the existing cache is returned.
 */
export async function refreshClaudeModels(
  apiKey: string | undefined
): Promise<DiscoveredClaudeModel[]> {
  if (inFlight) return inFlight;
  if (!apiKey) {
    logger.debug('No Anthropic API key available; keeping static Claude catalog');
    return cachedModels ?? [];
  }

  inFlight = fetchClaudeModelsFromApi(apiKey)
    .then((models) => {
      if (models.length > 0) {
        cachedModels = models;
        cacheExpiry = Date.now() + CLAUDE_MODEL_CACHE_DURATION_MS;
        logger.debug(`Cached ${models.length} models from the Anthropic API`);
      }
      return cachedModels ?? [];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
