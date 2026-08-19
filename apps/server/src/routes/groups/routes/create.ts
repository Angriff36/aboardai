/**
 * POST /api/groups/create — Create a new task group
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Feature } from '@aboardai/types';
import type { GroupService } from '../../../services/group-service.js';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import { createFeatureBranchName } from '../../../services/feature-worktree-assignment.js';
import { GroupCommandDenied } from '../../../groups/group-engine.js';
import { getErrorMessage, logError } from '../common.js';

/** Feature statuses that are eligible to be added to a group */
const ELIGIBLE_STATUSES = new Set(['backlog', 'ready']);

export function createCreateHandler(groupService: GroupService, featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, name, baseBranch, maxConcurrency, retryLimit, featureIds } =
        req.body as {
          projectPath?: string;
          name?: string;
          baseBranch?: string | null;
          maxConcurrency?: number;
          retryLimit?: number;
          featureIds?: string[];
        };

      // ── Validate required fields ────────────────────────────────────────────
      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required' });
        return;
      }
      if (!featureIds || featureIds.length < 2) {
        res.status(400).json({
          success: false,
          error: 'featureIds must be an array of at least 2 feature IDs',
        });
        return;
      }

      // ── Validate each feature exists and has eligible status ────────────────
      const failedFeatureIds: string[] = [];
      const features = new Map<string, Feature>();
      for (const featureId of featureIds) {
        const feature = await featureLoader.get(projectPath, featureId);
        if (!feature || !ELIGIBLE_STATUSES.has(feature.status ?? '')) {
          failedFeatureIds.push(featureId);
        } else {
          features.set(featureId, feature);
        }
      }

      if (failedFeatureIds.length > 0) {
        res.status(400).json({
          success: false,
          error: `Features not found or not in backlog/ready status: ${failedFeatureIds.join(', ')}`,
          failedFeatureIds,
        });
        return;
      }

      // ── Give every child its own execution branch; baseBranch is only its base ──
      for (const featureId of featureIds) {
        const feature = features.get(featureId)!;
        const ownedBranch =
          feature.worktreeMode === 'isolated' && feature.branchName
            ? feature.branchName
            : createFeatureBranchName(feature.id, feature.title);
        await featureLoader.update(projectPath, featureId, {
          worktreeMode: 'isolated',
          branchName: ownedBranch,
          worktreeBaseBranch:
            baseBranch ?? feature.worktreeBaseBranch ?? feature.branchName ?? undefined,
        });
      }

      // ── Create the group ────────────────────────────────────────────────────
      const { engine, store } = await groupService.ensureProject(projectPath);
      const id = crypto.randomUUID();

      await engine.createGroup({
        id,
        name,
        baseBranch: baseBranch ?? null,
        maxConcurrency: maxConcurrency ?? 1,
        retryLimit: retryLimit ?? 0,
        childFeatureIds: featureIds,
      });

      const snapshot = await engine.getSnapshot(id);
      await store.saveGroup(snapshot);

      res.json({ success: true, group: snapshot });
    } catch (error) {
      if (error instanceof GroupCommandDenied) {
        res.status(409).json({ error: error.message, guard: error.formatted });
        return;
      }
      logError(error, 'Create group failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
