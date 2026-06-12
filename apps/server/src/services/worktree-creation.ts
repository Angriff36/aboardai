/**
 * worktree-creation — guarded worktree find-or-create
 *
 * All worktree creation goes through ensureWorktree(), which:
 *   1. Acquires a per-(projectPath, branchName) mutex so that concurrent
 *      callers for the same branch are serialized (no double-create race).
 *   2. Re-checks for an existing worktree inside the lock (TOCTOU fix).
 *   3. Runs `git worktree add` if none found.
 *   4. On EEXIST-style git errors (cross-process race or stale state):
 *      re-resolves via findExistingWorktreeForBranch and returns that path.
 *
 * Design notes:
 *   - The existence check + `git worktree add` run INSIDE the mutex to eliminate
 *     the race window.
 *   - Config copy (WorktreeService.copyConfiguredFiles) and init-script execution
 *     happen OUTSIDE the mutex after creation succeeds.  They are not
 *     worktree-existence guards and it is safe (and desirable) to run them
 *     after the lock is released so that other branches are not blocked.
 *   - The orphaned-route 'create-worktree' action routes through here so it
 *     benefits from the same mutex + EEXIST fallback.
 */

import path from 'path';
import { execGitCommand } from '../lib/git.js';
import { KeyedMutex } from '../lib/keyed-mutex.js';
import { createLogger } from '@aboardai/utils';

const logger = createLogger('WorktreeCreation');

/** Singleton mutex shared by all callers in this process. */
export const worktreeCreationMutex = new KeyedMutex();

export interface EnsureWorktreeOptions {
  /**
   * Base branch or ref to create from when the branch does not yet exist.
   * Defaults to 'HEAD'.
   */
  baseBranch?: string;

  /**
   * Suffix to append to the sanitized directory name.
   * Useful when the caller needs a stable unique path (e.g. orphaned recovery).
   */
  dirSuffix?: string;
}

export interface EnsureWorktreeResult {
  /** Absolute path to the worktree. */
  path: string;
  /** The branch name. */
  branch: string;
  /**
   * True if the worktree was created by this call.
   * False if it already existed (found before or after the mutex was acquired).
   */
  isNew: boolean;
}

/**
 * Find an existing worktree for a given branch by parsing `git worktree list
 * --porcelain`.  Returns null if not found or on error.
 */
export async function findExistingWorktreeForBranch(
  projectPath: string,
  branchName: string
): Promise<{ path: string; branch: string } | null> {
  try {
    const stdout = await execGitCommand(['worktree', 'list', '--porcelain'], projectPath);

    const lines = stdout.split('\n');
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice(9);
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice(7).replace('refs/heads/', '');
      } else if (line === '' && currentPath && currentBranch) {
        if (currentBranch === branchName) {
          const resolvedPath = path.isAbsolute(currentPath)
            ? path.resolve(currentPath)
            : path.resolve(projectPath, currentPath);
          return { path: resolvedPath, branch: currentBranch };
        }
        currentPath = null;
        currentBranch = null;
      }
    }

    // Handle last entry if file doesn't end with newline
    if (currentPath && currentBranch && currentBranch === branchName) {
      const resolvedPath = path.isAbsolute(currentPath)
        ? path.resolve(currentPath)
        : path.resolve(projectPath, currentPath);
      return { path: resolvedPath, branch: currentBranch };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure a worktree exists for the given projectPath + branchName,
 * creating it if necessary. Serialized per (projectPath, branchName) to
 * prevent double-create races.
 */
export async function ensureWorktree(
  projectPath: string,
  branchName: string,
  opts: EnsureWorktreeOptions = {}
): Promise<EnsureWorktreeResult> {
  const { baseBranch, dirSuffix } = opts;
  const mutexKey = `${projectPath}::${branchName}`;

  return worktreeCreationMutex.run(mutexKey, async () => {
    // Re-check inside the lock (TOCTOU fix: another caller may have just created it)
    const existing = await findExistingWorktreeForBranch(projectPath, branchName);
    if (existing) {
      logger.info(`Found existing worktree for branch "${branchName}" at: ${existing.path}`);
      return { path: existing.path, branch: branchName, isNew: false };
    }

    // Compute destination path
    const sanitizedName = branchName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const dirName = dirSuffix ? `${sanitizedName}-${dirSuffix}` : sanitizedName;
    const worktreesDir = path.join(projectPath, '.worktrees');
    const worktreePath = path.join(worktreesDir, dirName);

    // Check whether the branch already exists
    let branchExists = false;
    try {
      await execGitCommand(['rev-parse', '--verify', branchName], projectPath);
      branchExists = true;
    } catch {
      // Branch doesn't exist yet — we'll create it
    }

    try {
      if (branchExists) {
        await execGitCommand(['worktree', 'add', worktreePath, branchName], projectPath);
      } else {
        const base = baseBranch || 'HEAD';
        await execGitCommand(
          ['worktree', 'add', '-b', branchName, worktreePath, base],
          projectPath
        );
      }
    } catch (addErr) {
      const msg = addErr instanceof Error ? addErr.message : String(addErr);
      const isAlreadyExists =
        msg.includes('already exists') ||
        msg.includes('already checked out') ||
        msg.includes('already locked');

      if (isAlreadyExists) {
        // Cross-process or stale-state race: the worktree exists in git's view
        // but we didn't see it in our earlier check.  Re-resolve and return it.
        logger.warn(
          `git worktree add reported "already exists" for branch "${branchName}"; re-resolving.`
        );
        const resolved = await findExistingWorktreeForBranch(projectPath, branchName);
        if (resolved) {
          return { path: resolved.path, branch: branchName, isNew: false };
        }
        // Extremely unlikely: add failed but we still can't find it — surface error
      }
      throw addErr;
    }

    const absoluteWorktreePath = path.resolve(worktreePath);
    logger.info(`Created worktree for branch "${branchName}" at: ${absoluteWorktreePath}`);
    return { path: absoluteWorktreePath, branch: branchName, isNew: true };
  });
}
