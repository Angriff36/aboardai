/**
 * GET /api/groups/list — List all task groups for a project
 */

import type { Request, Response } from 'express';
import type { GroupService } from '../../../services/group-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createListHandler(groupService: GroupService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const projectPath = req.query.projectPath as string | undefined;

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }

      const { store } = await groupService.getProjectGroup(projectPath);
      const groups = await store.loadAllGroups();

      res.json({ success: true, groups });
    } catch (error) {
      logError(error, 'List groups failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
