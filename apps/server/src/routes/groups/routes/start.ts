/**
 * POST /api/groups/start — Start executing a task group
 */

import type { Request, Response } from 'express';
import type { GroupService } from '../../../services/group-service.js';
import { GroupCommandDenied } from '../../../groups/group-engine.js';
import { getErrorMessage, logError } from '../common.js';

export function createStartHandler(groupService: GroupService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, groupId } = req.body as {
        projectPath?: string;
        groupId?: string;
      };

      if (!projectPath || !groupId) {
        res.status(400).json({ success: false, error: 'projectPath and groupId are required' });
        return;
      }

      const { engine, queue, store } = await groupService.ensureProject(projectPath);

      // Check group exists in engine before starting; rehydrate if needed
      try {
        await engine.getSnapshot(groupId);
      } catch {
        const persisted = await store.loadAllGroups();
        const found = persisted.find((g) => g.id === groupId);
        if (!found) {
          res.status(404).json({ success: false, error: `Group '${groupId}' not found` });
          return;
        }
        await engine.rehydrateGroup(found);
      }

      await queue.startGroup(projectPath, groupId);

      const snapshot = await engine.getSnapshot(groupId);
      res.json({ success: true, group: snapshot });
    } catch (error) {
      if (error instanceof GroupCommandDenied) {
        res.status(409).json({ error: error.message, guard: error.formatted });
        return;
      }
      logError(error, 'Start group failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
