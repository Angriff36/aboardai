/**
 * POST /events endpoint - Get persisted events for a feature (replay)
 */

import type { Request, Response } from 'express';
import { readEventLog } from '../../../events/event-log.js';
import { getErrorMessage, logError } from '../common.js';

export function createEventsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as { projectPath: string; featureId: string };

      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      const events = await readEventLog(projectPath, featureId);
      res.json({ success: true, events });
    } catch (error) {
      logError(error, 'Get feature events failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
