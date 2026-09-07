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

/** Resolve the key the same way the provider env builder does, plus saved-provider and z.ai fallbacks. */
async function resolveCompatibleApiKey(
  body: DiscoverModelsBody,
  settingsService: SettingsService
): Promise<string | undefined> {
  const source = body.apiKeySource ?? 'inline';
  if (source === 'env') return process.env.ANTHROPIC_API_KEY || undefined;

  const credentials = await settingsService.getCredentials().catch(() => null);
  if (source === 'credentials') return credentials?.apiKeys.anthropic || undefined;

  if (body.apiKey?.trim()) return body.apiKey.trim();

  if (body.providerId) {
    const settings = await settingsService.getGlobalSettings().catch(() => null);
    const saved = settings?.claudeCompatibleProviders?.find((p) => p.id === body.providerId);
    if (saved?.apiKey) return saved.apiKey;
  }

  // The z.ai key stored for usage tracking also works for GLM discovery.
  if (body.providerType === 'glm' && credentials?.apiKeys.zai) return credentials.apiKeys.zai;

  return undefined;
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

      const apiKey = await resolveCompatibleApiKey(body, settingsService);
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
