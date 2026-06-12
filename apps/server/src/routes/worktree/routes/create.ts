/**
 * POST /create endpoint - Create a new git worktree
 *
 * This endpoint handles worktree creation with proper checks:
 * 1. First checks if git already has a worktree for the branch (anywhere)
 * 2. If found, returns the existing worktree (no error)
 * 3. Syncs the base branch from its remote tracking branch (fast-forward only)
 * 4. Only creates a new worktree if none exists for the branch
 */

import type { Request, Response } from 'express';
import path from 'path';
import * as secureFs from '../../../lib/secure-fs.js';
import type { EventEmitter } from '../../../lib/events.js';
import type { SettingsService } from '../../../services/settings-service.js';
import { WorktreeService } from '../../../services/worktree-service.js';
import { isGitRepo } from '@aboardai/git-utils';
import {
  getErrorMessage,
  logError,
  normalizePath,
  ensureInitialCommit,
  isValidBranchName,
} from '../common.js';
import { execGitCommand } from '../../../lib/git.js';
import { trackBranch } from './branch-tracking.js';
import { createLogger } from '@aboardai/utils';
import { runInitScript } from '../../../services/init-script-service.js';
import {
  syncBaseBranch,
  type BaseBranchSyncResult,
} from '../../../services/branch-sync-service.js';
import { ensureWorktree } from '../../../services/worktree-creation.js';

const logger = createLogger('Worktree');

/** Timeout for git fetch operations (30 seconds) */
const FETCH_TIMEOUT_MS = 30_000;

export function createCreateHandler(events: EventEmitter, settingsService?: SettingsService) {
  const worktreeService = new WorktreeService();

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, branchName, baseBranch } = req.body as {
        projectPath: string;
        branchName: string;
        baseBranch?: string; // Optional base branch to create from (defaults to current HEAD). Can be a remote branch like "origin/main".
      };

      if (!projectPath || !branchName) {
        res.status(400).json({
          success: false,
          error: 'projectPath and branchName required',
        });
        return;
      }

      // Validate branch name to prevent command injection
      if (!isValidBranchName(branchName)) {
        res.status(400).json({
          success: false,
          error:
            'Invalid branch name. Branch names must contain only letters, numbers, dots, hyphens, underscores, and forward slashes.',
        });
        return;
      }

      // Validate base branch if provided
      if (baseBranch && !isValidBranchName(baseBranch) && baseBranch !== 'HEAD') {
        res.status(400).json({
          success: false,
          error:
            'Invalid base branch name. Branch names must contain only letters, numbers, dots, hyphens, underscores, and forward slashes.',
        });
        return;
      }

      if (!(await isGitRepo(projectPath))) {
        res.status(400).json({
          success: false,
          error: 'Not a git repository',
        });
        return;
      }

      // Ensure the repository has at least one commit so worktree commands referencing HEAD succeed
      // Pass git identity env vars so commits work without global git config
      const gitEnv = {
        GIT_AUTHOR_NAME: 'AboardAI',
        GIT_AUTHOR_EMAIL: 'aboardai@localhost',
        GIT_COMMITTER_NAME: 'AboardAI',
        GIT_COMMITTER_EMAIL: 'aboardai@localhost',
      };
      await ensureInitialCommit(projectPath, gitEnv);

      // Create worktrees directory ahead of time (ensureWorktree needs it to exist)
      const worktreesDir = path.join(projectPath, '.worktrees');
      await secureFs.mkdir(worktreesDir, { recursive: true });

      // Fetch latest from all remotes before creating the worktree.
      // This ensures remote refs are up-to-date for:
      // - Remote base branches (e.g. "origin/main")
      // - Existing remote branches being checked out as worktrees
      // - Branch existence checks against fresh remote state
      logger.info('Fetching from all remotes before creating worktree');
      try {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          await execGitCommand(['fetch', '--all', '--quiet'], projectPath, undefined, controller);
        } finally {
          clearTimeout(timerId);
        }
      } catch (fetchErr) {
        // Non-fatal: log but continue — refs might already be cached locally
        logger.warn(`Failed to fetch from remotes: ${getErrorMessage(fetchErr)}`);
      }

      // Sync the base branch with its remote tracking branch (fast-forward only).
      // This ensures the new worktree starts from an up-to-date state rather than
      // a potentially stale local copy. If the sync fails or the branch has diverged,
      // we proceed with the local copy and inform the user.
      const effectiveBase = baseBranch || 'HEAD';
      let syncResult: BaseBranchSyncResult = { attempted: false, synced: false };

      // Only sync if the base is a real branch (not 'HEAD')
      // Pass skipFetch=true because we already fetched all remotes above.
      if (effectiveBase !== 'HEAD') {
        logger.info(`Syncing base branch '${effectiveBase}' before creating worktree`);
        syncResult = await syncBaseBranch(projectPath, effectiveBase, true);
        if (syncResult.attempted) {
          if (syncResult.synced) {
            logger.info(`Base branch sync result: ${syncResult.message}`);
          } else {
            logger.warn(`Base branch sync result: ${syncResult.message}`);
          }
        }
      } else {
        // When using HEAD, try to sync the currently checked-out branch
        // Pass skipFetch=true because we already fetched all remotes above.
        try {
          const currentBranch = await execGitCommand(
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            projectPath
          );
          const trimmedBranch = currentBranch.trim();
          if (trimmedBranch && trimmedBranch !== 'HEAD') {
            logger.info(
              `Syncing current branch '${trimmedBranch}' (HEAD) before creating worktree`
            );
            syncResult = await syncBaseBranch(projectPath, trimmedBranch, true);
            if (syncResult.attempted) {
              if (syncResult.synced) {
                logger.info(`HEAD branch sync result: ${syncResult.message}`);
              } else {
                logger.warn(`HEAD branch sync result: ${syncResult.message}`);
              }
            }
          }
        } catch {
          // Could not determine HEAD branch — skip sync
        }
      }

      // --- Guarded find-or-create (mutex eliminates the TOCTOU race) ---
      // ensureWorktree acquires a per-(projectPath, branchName) lock, re-checks
      // for an existing worktree inside the lock, runs `git worktree add` only
      // when none exists, and re-resolves on EEXIST-style errors (cross-process
      // races the in-process mutex cannot cover).
      const worktreeResult = await ensureWorktree(projectPath, branchName, { baseBranch });

      // Note: We intentionally do NOT symlink .aboardai to worktrees.
      // Features and config are always accessed from the main project path.
      // This avoids symlink loop issues when activating worktrees.

      // Track the branch so it persists in the UI even after worktree is removed.
      await trackBranch(projectPath, branchName);

      const absoluteWorktreePath = worktreeResult.path;

      if (!worktreeResult.isNew) {
        // Worktree already existed — return early without config copy / init script.
        res.json({
          success: true,
          worktree: {
            path: normalizePath(absoluteWorktreePath),
            branch: branchName,
            isNew: false,
          },
        });
        return;
      }

      // Get the commit hash the new worktree is based on for logging
      let baseCommitHash: string | undefined;
      try {
        const hash = await execGitCommand(['rev-parse', '--short', 'HEAD'], absoluteWorktreePath);
        baseCommitHash = hash.trim();
      } catch {
        // Non-critical — just for logging
      }

      if (baseCommitHash) {
        logger.info(`New worktree for '${branchName}' based on commit ${baseCommitHash}`);
      }

      // Copy configured files into the new worktree before responding.
      // Runs outside the mutex — safe to do so: creation is already committed.
      try {
        await worktreeService.copyConfiguredFiles(
          projectPath,
          absoluteWorktreePath,
          settingsService,
          events
        );
      } catch (copyErr) {
        // Log but don't fail worktree creation – files may be partially copied
        logger.warn('Some configured files failed to copy to worktree:', copyErr);
      }

      // Respond immediately (non-blocking)
      res.json({
        success: true,
        worktree: {
          path: normalizePath(absoluteWorktreePath),
          branch: branchName,
          isNew: true,
          baseCommitHash,
          ...(syncResult.attempted
            ? {
                syncResult: {
                  synced: syncResult.synced,
                  remote: syncResult.remote,
                  message: syncResult.message,
                  diverged: syncResult.diverged,
                },
              }
            : {}),
        },
      });

      // Trigger init script asynchronously after response.
      // Outside the mutex — same rationale as config copy above.
      // runInitScript internally checks if script exists and hasn't already run.
      runInitScript({
        projectPath,
        worktreePath: absoluteWorktreePath,
        branch: branchName,
        emitter: events,
      }).catch((err) => {
        logger.error(`Init script failed for ${branchName}:`, err);
      });
    } catch (error) {
      logError(error, 'Create worktree failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
