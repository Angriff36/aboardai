/**
 * Anthropic model discovery via `GET /v1/models`.
 *
 * The cache is module-level so every ClaudeProvider instance (the factory
 * creates a new one per call) sees the same discovered list.
 */

import { readFile } from 'node:fs/promises';
import { getClaudeCredentialPaths } from '@aboardai/platform';
import { createLogger } from '@aboardai/utils';

const logger = createLogger('ClaudeModelDiscovery');

/** Beta header that lets a Claude Code OAuth token call the Anthropic API. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Either an API key or a Claude Code (subscription) OAuth access token. */
export type ClaudeDiscoveryAuth = { apiKey: string } | { oauthToken: string };

/** Headers for `GET /v1/models` for the given auth method. */
export function buildClaudeModelsHeaders(auth: ClaudeDiscoveryAuth): Record<string, string> {
  if ('apiKey' in auth) {
    return { 'x-api-key': auth.apiKey, 'anthropic-version': '2023-06-01' };
  }
  return {
    Authorization: `Bearer ${auth.oauthToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': OAUTH_BETA_HEADER,
  };
}

/**
 * Read the Claude Code CLI OAuth access token (Claude Max / Pro subscription
 * login) from the CLI credentials file, if present.
 */
export async function readClaudeOAuthToken(): Promise<string | undefined> {
  for (const credentialPath of getClaudeCredentialPaths()) {
    try {
      const parsed = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        claudeAiOauth?: { accessToken?: unknown };
      };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === 'string' && token.trim()) return token.trim();
    } catch {
      // Missing or unreadable file — try the next path
    }
  }
  return undefined;
}

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
  auth: ClaudeDiscoveryAuth,
  baseUrl: string = process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL
): Promise<DiscoveredClaudeModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`;
  const response = await fetch(url, {
    headers: buildClaudeModelsHeaders(auth),
    redirect: 'manual', // never carry the credential to a redirected host
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
 * Refresh the cache from the API. Uses the API key when one is configured,
 * otherwise the Claude Code subscription (OAuth) token. With neither,
 * discovery is skipped and the existing cache is returned.
 */
export async function refreshClaudeModels(
  apiKey: string | undefined
): Promise<DiscoveredClaudeModel[]> {
  if (inFlight) return inFlight;

  // The credential read is inside the shared promise so concurrent callers coalesce.
  inFlight = (async () => {
    try {
      let models: DiscoveredClaudeModel[];
      if (apiKey) {
        // API-key failures propagate so the settings UI can show the reason.
        models = await fetchClaudeModelsFromApi({ apiKey });
      } else {
        const oauthToken = await readClaudeOAuthToken();
        if (!oauthToken) {
          logger.debug('No Anthropic API key or Claude Code login found; keeping static catalog');
          return cachedModels ?? [];
        }
        try {
          // The subscription token is only ever sent to Anthropic itself —
          // never to an ANTHROPIC_BASE_URL override.
          models = await fetchClaudeModelsFromApi({ oauthToken }, DEFAULT_ANTHROPIC_BASE_URL);
        } catch (error) {
          // Expired login or network trouble must not break the catalog.
          logger.debug(`Claude subscription model discovery failed; keeping catalog: ${error}`);
          return cachedModels ?? [];
        }
      }
      if (models.length > 0) {
        cachedModels = models;
        cacheExpiry = Date.now() + CLAUDE_MODEL_CACHE_DURATION_MS;
        logger.debug(`Cached ${models.length} models from the Anthropic API`);
      }
      return cachedModels ?? [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
