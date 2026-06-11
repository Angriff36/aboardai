/**
 * POST /migrate endpoint - Migration endpoint (no longer needed)
 *
 * This endpoint is kept for backwards compatibility but no longer performs
 * any migration since .aboardai is now stored in the project directory.
 */

import type { Request, Response } from 'express';
import { getAboardAIDir } from '@aboardai/platform';

export function createMigrateHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { projectPath } = req.body as { projectPath: string };

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'projectPath is required',
      });
      return;
    }

    // Migration is no longer needed - .aboardai is stored in project directory
    const aboardaiDir = getAboardAIDir(projectPath);
    res.json({
      success: true,
      migrated: false,
      message: 'No migration needed - .aboardai is stored in project directory',
      path: aboardaiDir,
    });
  };
}
