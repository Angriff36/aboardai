/**
 * Gemini model discovery via the Generative Language API `GET /v1beta/models`.
 *
 * The cache is module-level so every GeminiProvider instance shares it.
 */

import { GEMINI_MODEL_MAP, type GeminiModelId } from '@aboardai/types';
import { createLogger } from '@aboardai/utils';
import type { ModelDefinition } from './types.js';

const logger = createLogger('GeminiModelDiscovery');

/** Cache duration for dynamic model fetching (30 minutes) */
export const GEMINI_MODEL_CACHE_DURATION_MS = 30 * 60 * 1000;

export const GEMINI_MODELS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';

/** Model id fragments that are not chat/agent models (tts, image, embeddings, ...). */
const EXCLUDED_ID_PATTERN = /(-tts|-image|-audio|-live|embedding|-robotics|computer-use)/i;

/** Parse a `GET /v1beta/models` payload into ModelDefinitions for chat-capable Gemini models. */
export function parseGeminiModelsResponse(payload: unknown): ModelDefinition[] {
  if (!payload || typeof payload !== 'object') return [];
  const list = (payload as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
    if (!id.startsWith('gemini-') || seen.has(id) || EXCLUDED_ID_PATTERN.test(id)) continue;

    const methods = Array.isArray(record.supportedGenerationMethods)
      ? (record.supportedGenerationMethods as unknown[])
      : [];
    if (methods.length > 0 && !methods.includes('generateContent')) continue;

    seen.add(id);
    const staticConfig = GEMINI_MODEL_MAP[id as GeminiModelId];
    const displayName =
      typeof record.displayName === 'string' && record.displayName.trim()
        ? record.displayName.trim()
        : (staticConfig?.label ?? id);
    const description =
      typeof record.description === 'string' && record.description.trim()
        ? record.description.trim()
        : (staticConfig?.description ?? `Gemini model: ${id}`);
    const hasReasoning =
      staticConfig?.supportsThinking ??
      (record.thinking === true || /gemini-(2\.5|[3-9])/.test(id));

    models.push({
      id,
      name: displayName,
      modelString: id,
      provider: 'gemini',
      description,
      contextWindow:
        typeof record.inputTokenLimit === 'number'
          ? record.inputTokenLimit
          : staticConfig?.contextWindow,
      maxOutputTokens:
        typeof record.outputTokenLimit === 'number' ? record.outputTokenLimit : undefined,
      supportsVision: staticConfig?.supportsVision ?? true,
      supportsTools: true,
      hasReasoning,
    });
  }
  return models;
}

/** Static fallback models from GEMINI_MODEL_MAP when API discovery is unavailable. */
export function getStaticGeminiModelDefinitions(): ModelDefinition[] {
  return Object.entries(GEMINI_MODEL_MAP).map(([id, config]) => ({
    id, // Full model ID with gemini- prefix (e.g., 'gemini-2.5-flash')
    name: config.label,
    modelString: id, // Same as id - CLI uses the full model name
    provider: 'gemini',
    description: config.description,
    supportsTools: true,
    supportsVision: config.supportsVision,
    contextWindow: config.contextWindow,
    hasReasoning: config.supportsThinking,
  }));
}

/** Fetch the model list from the Gemini API. Throws on HTTP or network failure. */
export async function fetchGeminiModelsFromApi(
  apiKey: string,
  endpoint: string = GEMINI_MODELS_ENDPOINT
): Promise<ModelDefinition[]> {
  const response = await fetch(endpoint, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Gemini models request failed: HTTP ${response.status}`);
  }
  return parseGeminiModelsResponse(await response.json());
}

let cachedModels: ModelDefinition[] | null = null;
let cacheExpiry = 0;
let inFlight: Promise<ModelDefinition[]> | null = null;

export function getCachedGeminiModels(): ModelDefinition[] | null {
  return cachedModels;
}

export function hasCachedGeminiModels(): boolean {
  return cachedModels !== null && cachedModels.length > 0;
}

export function isGeminiModelCacheStale(): boolean {
  return Date.now() >= cacheExpiry;
}

export function clearGeminiModelCache(): void {
  cachedModels = null;
  cacheExpiry = 0;
  logger.debug('Cleared Gemini model cache');
}

/**
 * Refresh the cache from the API. Without an API key (Gemini CLI OAuth users)
 * discovery is skipped and the existing cache is returned.
 */
export async function refreshGeminiModels(apiKey: string | undefined): Promise<ModelDefinition[]> {
  if (inFlight) return inFlight;
  if (!apiKey) {
    logger.debug('No Gemini API key available; keeping static Gemini catalog');
    return cachedModels ?? [];
  }

  inFlight = fetchGeminiModelsFromApi(apiKey)
    .then((models) => {
      if (models.length > 0) {
        cachedModels = models;
        cacheExpiry = Date.now() + GEMINI_MODEL_CACHE_DURATION_MS;
        logger.debug(`Cached ${models.length} models from the Gemini API`);
      }
      return cachedModels ?? [];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
