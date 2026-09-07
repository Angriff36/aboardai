/**
 * Gemini Dynamic Models API Routes
 *
 * - GET /api/setup/gemini/models - Get available models (cached or refreshed)
 * - POST /api/setup/gemini/models/refresh - Force refresh from the Gemini API
 * - POST /api/setup/gemini/cache/clear - Clear model cache
 */

import type { Request, Response } from 'express';
import type { ModelDefinition } from '@aboardai/types';
import { GeminiProvider } from '../../../providers/gemini-provider.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { getApiKey, getErrorMessage, logError } from '../common.js';

let providerInstance: GeminiProvider | null = null;

function getProvider(): GeminiProvider {
  if (!providerInstance) {
    providerInstance = new GeminiProvider();
  }
  return providerInstance;
}

interface ModelsResponse {
  success: boolean;
  models?: ModelDefinition[];
  count?: number;
  cached?: boolean;
  /** 'api' when the list came from the Gemini API, 'static' when it is the built-in map */
  source?: 'api' | 'static';
  error?: string;
}

/** Resolve the Gemini API key from environment, stored credentials, or the in-memory setup cache. */
export async function resolveGeminiApiKey(
  settingsService: SettingsService
): Promise<string | undefined> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const credentials = await settingsService.getCredentials();
    if (credentials.apiKeys.google) return credentials.apiKeys.google;
  } catch {
    // Fall through to the in-memory cache
  }
  return getApiKey('google') || undefined;
}

export function createGetGeminiModelsHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const forceRefresh = req.query.refresh === 'true';

      let models: ModelDefinition[];
      let cached = true;

      if (forceRefresh || !provider.hasCachedModels()) {
        models = await provider.refreshModels(await resolveGeminiApiKey(settingsService));
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
      logError(error, 'Get Gemini models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createRefreshGeminiModelsHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const models = await provider.refreshModels(await resolveGeminiApiKey(settingsService));

      res.json({
        success: true,
        models,
        count: models.length,
        cached: false,
        source: provider.hasCachedModels() ? 'api' : 'static',
      } satisfies ModelsResponse);
    } catch (error) {
      logError(error, 'Refresh Gemini models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createClearGeminiCacheHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      getProvider().clearModelCache();
      res.json({ success: true, message: 'Gemini model cache cleared' });
    } catch (error) {
      logError(error, 'Clear Gemini cache failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
