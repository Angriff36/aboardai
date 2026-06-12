/**
 * GET /api/groups/get — Get a single task group snapshot
 */

import type { Request, Response } from 'express';
import type { GroupService } from '../../../services/group-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createGetHandler(groupService: GroupService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const projectPath = req.query.projectPath as string | undefined;
      const groupId = req.query.groupId as string | undefined;

      if (!projectPath || !groupId) {
        res.status(400).json({ success: false, error: 'projectPath and groupId are required' });
        return;
      }

      const { engine, store } = await groupService.getProjectGroup(projectPath);

      // Try to get snapshot from engine; if not loaded, rehydrate from store first
      let snapshot;
      try {
        snapshot = await engine.getSnapshot(groupId);
      } catch (engineErr) {
        // Engine doesn't have this group loaded — try rehydrating from store
        const persisted = await store.loadAllGroups();
        const found = persisted.find((g) => g.id === groupId);
        if (!found) {
          res.status(404).json({ success: false, error: `Group '${groupId}' not found` });
          return;
        }
        await engine.rehydrateGroup(found);
        snapshot = await engine.getSnapshot(groupId);
      }

      res.json({ success: true, group: snapshot });
    } catch (error) {
      logError(error, 'Get group failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
