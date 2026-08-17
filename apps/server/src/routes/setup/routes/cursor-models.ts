/**
 * Cursor Dynamic Models API Routes
 *
 * - GET /api/setup/cursor/models - Get available models (cached or refreshed)
 * - POST /api/setup/cursor/models/refresh - Force refresh from CLI
 * - POST /api/setup/cursor/cache/clear - Clear model cache
 */

import type { Request, Response } from 'express';
import { CursorProvider } from '../../../providers/cursor-provider.js';
import { getErrorMessage, logError } from '../common.js';
import type { ModelDefinition } from '@aboardai/types';

let providerInstance: CursorProvider | null = null;

function getProvider(): CursorProvider {
  if (!providerInstance) {
    providerInstance = new CursorProvider();
  }
  return providerInstance;
}

interface ModelsResponse {
  success: boolean;
  models?: ModelDefinition[];
  count?: number;
  cached?: boolean;
  error?: string;
}

export function createGetCursorModelsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const forceRefresh = req.query.refresh === 'true';

      let models: ModelDefinition[];
      let cached = true;

      if (forceRefresh) {
        models = await provider.refreshModels();
        cached = false;
      } else if (!provider.hasCachedModels()) {
        models = await provider.refreshModels();
        cached = false;
      } else {
        models = provider.getAvailableModels();
      }

      res.json({
        success: true,
        models,
        count: models.length,
        cached,
      } satisfies ModelsResponse);
    } catch (error) {
      logError(error, 'Get Cursor models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createRefreshCursorModelsHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      const models = await provider.refreshModels();

      res.json({
        success: true,
        models,
        count: models.length,
        cached: false,
      } satisfies ModelsResponse);
    } catch (error) {
      logError(error, 'Refresh Cursor models failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      } satisfies ModelsResponse);
    }
  };
}

export function createClearCursorCacheHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const provider = getProvider();
      provider.clearModelCache();

      res.json({
        success: true,
        message: 'Cursor model cache cleared',
      });
    } catch (error) {
      logError(error, 'Clear Cursor cache failed');
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
