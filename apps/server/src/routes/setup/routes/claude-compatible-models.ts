/**
 * Claude-compatible provider model discovery
 *
 * - POST /api/setup/claude-compatible/models
 *   Body: { baseUrl, apiKey?, apiKeySource?, providerId?, providerType? }
 *   Fetches `GET {baseUrl}/v1/models` with the resolved key and returns
 *   ProviderModel entries ready to store on the provider.
 */

import type { Request, Response } from 'express';
import type { ApiKeySource, ClaudeCompatibleProviderType, ProviderModel } from '@aboardai/types';
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
  apiKeySource?: ApiKeySource;
  providerId?: string;
  providerType?: ClaudeCompatibleProviderType;
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

/**
 * Server-held keys (credentials file, env, saved providers) may only be sent to
 * endpoints the user already configured or the built-in templates. The setup
 * routes are unauthenticated, so an arbitrary baseUrl must never receive them.
 */
export function isTrustedBaseUrl(
  baseUrl: string,
  savedProviders: ReadonlyArray<{ baseUrl: string }>
): boolean {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return false;
  return (
    savedProviders.some((p) => normalizeBaseUrl(p.baseUrl) === target) ||
    CLAUDE_PROVIDER_TEMPLATES.some((t) => normalizeBaseUrl(t.baseUrl) === target)
  );
}

const UNTRUSTED_URL_ERROR =
  'Enter the API key in the form to fetch models from a custom URL. Server-stored keys are only sent to saved providers or built-in templates.';

/** Resolve the key the same way the provider env builder does, plus saved-provider and z.ai fallbacks. */
async function resolveCompatibleApiKey(
  body: DiscoverModelsBody,
  baseUrl: string,
  settingsService: SettingsService
): Promise<{ apiKey?: string; error?: string }> {
  // A key typed into the form belongs to the caller; no server secret is involved.
  const source = body.apiKeySource ?? 'inline';
  if (source === 'inline' && body.apiKey?.trim()) return { apiKey: body.apiKey.trim() };

  const settings = await settingsService.getGlobalSettings().catch(() => null);
  const savedProviders = settings?.claudeCompatibleProviders ?? [];
  if (!isTrustedBaseUrl(baseUrl, savedProviders)) return { error: UNTRUSTED_URL_ERROR };

  if (source === 'env') return { apiKey: process.env.ANTHROPIC_API_KEY || undefined };

  const credentials = await settingsService.getCredentials().catch(() => null);
  if (source === 'credentials') return { apiKey: credentials?.apiKeys.anthropic || undefined };

  if (body.providerId) {
    const saved = savedProviders.find((p) => p.id === body.providerId);
    if (saved?.apiKey) return { apiKey: saved.apiKey };
  }

  // The z.ai key stored for usage tracking also works for GLM discovery.
  if (body.providerType === 'glm' && credentials?.apiKeys.zai) {
    return { apiKey: credentials.apiKeys.zai };
  }

  return {};
}

export function createDiscoverClaudeCompatibleModelsHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as DiscoverModelsBody;
      const baseUrl = body.baseUrl?.trim();
      if (!baseUrl) {
        res
          .status(400)
          .json({ success: false, error: 'baseUrl is required' } satisfies DiscoverModelsResponse);
        return;
      }

      const { apiKey, error } = await resolveCompatibleApiKey(body, baseUrl, settingsService);
      if (error) {
        res.status(403).json({ success: false, error } satisfies DiscoverModelsResponse);
        return;
      }
      if (!apiKey) {
        res.status(400).json({
          success: false,
          error: 'No API key available for this provider. Enter the key first, then fetch models.',
        } satisfies DiscoverModelsResponse);
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
