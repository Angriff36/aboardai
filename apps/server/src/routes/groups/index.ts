/**
 * Groups routes — HTTP API for task group management.
 *
 * Provides CRUD + lifecycle endpoints for TaskGroup entities.
 * Groups execute features in parallel with concurrency/retry controls.
 */

import { Router } from 'express';
import type { GroupService } from '../../services/group-service.js';
import type { FeatureLoader } from '../../services/feature-loader.js';
import { createCreateHandler } from './routes/create.js';
import { createListHandler } from './routes/list.js';
import { createGetHandler } from './routes/get.js';
import { createStartHandler } from './routes/start.js';
import { createCancelHandler } from './routes/cancel.js';

export function createGroupRoutes(
  groupService: GroupService,
  featureLoader: FeatureLoader
): Router {
  const router = Router();

  router.post('/create', createCreateHandler(groupService, featureLoader));
  router.get('/list', createListHandler(groupService));
  router.get('/get', createGetHandler(groupService));
  router.post('/start', createStartHandler(groupService));
  router.post('/cancel', createCancelHandler(groupService));

  return router;
}
