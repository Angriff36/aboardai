/**
 * Claude Dynamic Models API Routes
 *
 * - GET /api/setup/claude/models - Get available models (cached or refreshed)
 * - POST /api/setup/claude/models/refresh - Force refresh from the Anthropic API
 * - POST /api/setup/claude/cache/clear - Clear model cache
 */

import type { Request, Response } from 'express';
import type { ModelDefinition } from '@aboardai/types';
import { ClaudeProvider } from '../../../providers/claude-provider.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { getApiKey, getErrorMessage, logError } from '../common.js';

let providerInstance: ClaudeProvider | null = null;

function getProvider(): ClaudeProvider {
  if (!providerInstance) {
    providerInstance = new ClaudeProvider();
  }
  return providerInstance;
}

interface ModelsResponse {
  success: boolean;
  models?: ModelDefinition[];
  count?: number;
  cached?: boolean;
  /** 'api' when the list came from the Anthropic API, 'static' when it is the built-in table */
  source?: 'api' | 'static';
  error?: string;
}

/** Resolve the Anthropic API key from stored credentials, environment, or the in-memory setup cache. */
export async function resolveAnthropicApiKey(
  settingsService: SettingsService
): Promise<string | undefined> {
  try {
    const credentials = await settingsService.getCredentials();
    if (credentials.apiKeys.anthropic) return credentials.apiKeys.anthropic;
  } catch {
    // Fall through to environment
  }
  return process.env.ANTHROPIC_API_KEY || getApiKey('anthropic') || undefined;
}

export function createGetClaudeModelsHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const forceRefresh = req.query.refresh === 'true';

      let models: ModelDefinition[];
      let cached = true;

      if (forceRefresh || !provider.hasCachedModels() || provider.isModelCacheStale()) {
        models = await provider.refreshModels(await resolveAnthropicApiKey(settingsService));
        cached = false;
      } else {
        models = provider.getAvailableModels();
      }

      res.json({
        success: true,
        models,
        count: models.length,
        cached,
        source: provider.hasCachedModels() ? 'api' : 'static',
      } satisfies ModelsResponse);
    } catch (error) {
      logError(error, 'Get Claude models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createRefreshClaudeModelsHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const models = await provider.refreshModels(await resolveAnthropicApiKey(settingsService));

      res.json({
        success: true,
        models,
        count: models.length,
        cached: false,
        source: provider.hasCachedModels() ? 'api' : 'static',
      } satisfies ModelsResponse);
    } catch (error) {
      logError(error, 'Refresh Claude models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createClearClaudeCacheHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      getProvider().clearModelCache();
      res.json({ success: true, message: 'Claude model cache cleared' });
    } catch (error) {
      logError(error, 'Clear Claude cache failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
