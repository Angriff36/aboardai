/**
 * Claude-compatible provider model discovery
 *
 * - POST /api/setup/claude-compatible/models
 *   Body: { baseUrl, apiKey? }
 *   Fetches `GET {baseUrl}/v1/models` and returns ProviderModel entries ready
 *   to store on the provider.
 *
 * Key resolution: a key in the body is the caller's own and is used as-is.
 * Otherwise the key comes ONLY from the saved provider (or built-in template)
 * whose base URL matches the request — the setup routes are unauthenticated,
 * so server-held secrets must never be routed to a URL they were not
 * configured for.
 */

import type { Request, Response } from 'express';
import type { Credentials, ProviderModel } from '@aboardai/types';
import { CLAUDE_PROVIDER_TEMPLATES } from '@aboardai/types';
import {
  fetchClaudeCompatibleModels,
  toProviderModels,
} from '../../../providers/claude-compatible-model-discovery.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { getErrorMessage, logError } from '../common.js';

interface DiscoverModelsBody {
  baseUrl?: string;
  apiKey?: string;
}

interface DiscoverModelsResponse {
  success: boolean;
  models?: ProviderModel[];
  count?: number;
  error?: string;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** Only http(s) targets are proxied; no file:, data:, or other schemes. */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Saved provider or built-in template that owns this base URL, if any. */
export function findProviderForBaseUrl<T extends { baseUrl: string }>(
  baseUrl: string,
  candidates: ReadonlyArray<T>
): T | undefined {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return undefined;
  return candidates.find((c) => normalizeBaseUrl(c.baseUrl) === target);
}

/** Server-held keys may only go to a saved provider or template that owns the URL. */
export function isTrustedBaseUrl(
  baseUrl: string,
  savedProviders: ReadonlyArray<{ baseUrl: string }>
): boolean {
  return (
    findProviderForBaseUrl(baseUrl, savedProviders) !== undefined ||
    findProviderForBaseUrl(baseUrl, CLAUDE_PROVIDER_TEMPLATES) !== undefined
  );
}

const NO_KEY_ERROR = 'Enter the API key first, then fetch models.';

/**
 * Resolve the key for a saved provider from ITS OWN configured source.
 * A GLM template URL with no saved provider may use the z.ai key stored
 * for usage tracking, since that key belongs to the same service.
 */
export function resolveServerHeldKey(
  baseUrl: string,
  savedProviders: ReadonlyArray<{
    baseUrl: string;
    apiKeySource?: string;
    apiKey?: string;
  }>,
  credentials: Credentials | null,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const saved = findProviderForBaseUrl(baseUrl, savedProviders);
  if (saved) {
    switch (saved.apiKeySource ?? 'inline') {
      case 'env':
        return env.ANTHROPIC_API_KEY || undefined;
      case 'credentials':
        return credentials?.apiKeys.anthropic || undefined;
      default:
        return saved.apiKey || undefined;
    }
  }

  const template = findProviderForBaseUrl(baseUrl, CLAUDE_PROVIDER_TEMPLATES);
  if (template?.providerType === 'glm' && credentials?.apiKeys.zai) {
    return credentials.apiKeys.zai;
  }
  return undefined;
}

export function createDiscoverClaudeCompatibleModelsHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as DiscoverModelsBody;
      const baseUrl = body.baseUrl?.trim();
      if (!baseUrl || !isHttpUrl(baseUrl)) {
        res.status(400).json({
          success: false,
          error: 'baseUrl must be an http(s) URL',
        } satisfies DiscoverModelsResponse);
        return;
      }

      let apiKey = body.apiKey?.trim() || undefined;
      if (!apiKey) {
        const settings = await settingsService.getGlobalSettings().catch(() => null);
        const credentials = await settingsService.getCredentials().catch(() => null);
        apiKey = resolveServerHeldKey(
          baseUrl,
          settings?.claudeCompatibleProviders ?? [],
          credentials
        );
      }
      if (!apiKey) {
        res
          .status(400)
          .json({ success: false, error: NO_KEY_ERROR } satisfies DiscoverModelsResponse);
        return;
      }

      const discovered = await fetchClaudeCompatibleModels({ baseUrl, apiKey });
      const models = toProviderModels(discovered);

      res.json({ success: true, models, count: models.length } satisfies DiscoverModelsResponse);
    } catch (error) {
      logError(error, 'Discover Claude-compatible models failed');
      res.status(502).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies DiscoverModelsResponse);
    }
  };
}
