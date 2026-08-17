/**
 * Models routes - HTTP API for model providers and availability
 */

import { Router } from 'express';
import { createAvailableHandler } from './routes/available.js';
import { createProvidersHandler } from './routes/providers.js';
import { createVerifyAccessHandler } from './routes/verify-access.js';
import { validatePathParams } from '../../middleware/validate-paths.js';
import type { SettingsService } from '../../services/settings-service.js';

export function createModelsRoutes(settingsService: SettingsService): Router {
  const router = Router();

  router.get('/available', createAvailableHandler());
  router.get('/providers', createProvidersHandler());
  router.post(
    '/verify-access',
    validatePathParams('projectPath'),
    createVerifyAccessHandler(settingsService)
  );

  return router;
}
