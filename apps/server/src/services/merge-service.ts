/**
 * MergeService - Direct merge operations without HTTP
 *
 * Extracted from worktree merge route to allow internal service calls.
 */

import { createLogger, isValidBranchName, isValidRemoteName } from '@aboardai/utils';
import { type EventEmitter } from '../lib/events.js';
import { execGitCommand } from '@aboardai/git-utils';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { KeyedMutex } from '../lib/keyed-mutex.js';
import { getIntegrationBranch } from '../lib/integration-branch.js';
const logger = createLogger('MergeService');

const mergeMutex = new KeyedMutex();
const REPOSITORY_LOCK_DIRECTORY = 'aboardai-main-merge.lock';
const REPOSITORY_LOCK_TIMEOUT_MS = 60_000;
const REPOSITORY_LOCK_STALE_MS = 10 * 60_000;

interface MergeWorkspace {
  path: string;
  temporary: boolean;
  /** The target checkout has uncommitted work of its own (e.g. other agents). */
  dirty: boolean;
}

function parseWorktreeForBranch(output: string, branchName: string): string | null {
  let worktreePath: string | null = null;
  for (const line of `${output}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branchName}` && worktreePath) {
      return worktreePath;
    } else if (line.length === 0) {
      worktreePath = null;
    }
  }
  return null;
}

function getRelevantStatusLines(statusOutput: string): string[] {
  return statusOutput
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^\?\? (?:\.aboardai|\.worktrees)(?:\/|$)/.test(line));
}

async function resolveMergeWorkspace(
  projectPath: string,
  targetBranch: string
): Promise<MergeWorkspace> {
  const worktreeList = await execGitCommand(['worktree', 'list', '--porcelain'], projectPath);
  const existingTargetWorktree = parseWorktreeForBranch(worktreeList, targetBranch);
  if (existingTargetWorktree) {
    // A dirty target checkout (other agents' uncommitted files) is merged into
    // fast-forward only; git refuses if the merge would touch those files.
    const trackedStatus = await execGitCommand(['status', '--porcelain'], existingTargetWorktree);
    return {
      path: existingTargetWorktree,
      temporary: false,
      dirty: getRelevantStatusLines(trackedStatus).length > 0,
    };
  }

  const temporaryPath = join(tmpdir(), `aboardai-merge-${randomUUID()}`);
  await execGitCommand(['worktree', 'add', temporaryPath, targetBranch], projectPath);
  const checkedOutRef = (
    await execGitCommand(['symbolic-ref', '--quiet', 'HEAD'], temporaryPath)
  ).trim();
  if (checkedOutRef !== `refs/heads/${targetBranch}`) {
    await execGitCommand(['worktree', 'remove', '--force', temporaryPath], projectPath).catch(
      () => {}
    );
    throw new Error(`Temporary merge workspace did not check out ${targetBranch}`);
  }
  return { path: temporaryPath, temporary: true, dirty: false };
}

/** Unmerged paths in a checkout (empty when there is no conflict). */
async function listConflictFiles(path: string): Promise<string[]> {
  const output = await execGitCommand(['diff', '--name-only', '--diff-filter=U'], path, {
    LC_ALL: 'C',
  }).catch(() => '');
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

async function abortMergeWorkspace(workspace: MergeWorkspace): Promise<void> {
  try {
    await execGitCommand(['merge', '--abort'], workspace.path);
  } catch {
    // Squash merges may not create MERGE_HEAD. The target is verified clean
    // before merging, so resetting tracked merge state to HEAD is safe here.
    await execGitCommand(['reset', '--merge', 'HEAD'], workspace.path);
  }
}

async function cleanupTemporaryMergeWorkspace(
  projectPath: string,
  workspace: MergeWorkspace | null
): Promise<void> {
  if (!workspace?.temporary) return;
  try {
    await execGitCommand(['worktree', 'remove', workspace.path], projectPath);
  } catch (firstError) {
    try {
      await execGitCommand(['worktree', 'remove', '--force', workspace.path], projectPath);
    } catch (forceError) {
      await execGitCommand(['worktree', 'prune'], projectPath).catch(() => {});
      const message = `Failed to remove temporary main merge worktree: ${workspace.path}`;
      logger.warn(message, {
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        forceError: forceError instanceof Error ? forceError.message : String(forceError),
      });
      throw new Error(message, { cause: forceError });
    }
  }
}

interface RepositoryIdentity {
  commonDir: string;
  key: string;
}

async function resolveRepositoryIdentity(projectPath: string): Promise<RepositoryIdentity> {
  const commonDirOutput = (
    await execGitCommand(['rev-parse', '--git-common-dir'], projectPath)
  ).trim();
  const absoluteCommonDir = isAbsolute(commonDirOutput)
    ? commonDirOutput
    : resolve(projectPath, commonDirOutput);
  let canonicalPath = normalize(absoluteCommonDir);
  try {
    canonicalPath = await realpath(canonicalPath);
  } catch {
    // The normalized absolute Git common-dir still provides a stable key when
    // filesystem canonicalization is unavailable.
  }
  return {
    commonDir: canonicalPath,
    key: process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath,
  };
}

interface RepositoryLockOwner {
  pid: number;
  createdAt: number;
  token?: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readRepositoryLockOwner(lockDirectory: string): Promise<RepositoryLockOwner | null> {
  try {
    return JSON.parse(
      await readFile(join(lockDirectory, 'owner.json'), 'utf8')
    ) as RepositoryLockOwner;
  } catch {
    return null;
  }
}

async function removeStaleRepositoryLock(lockDirectory: string): Promise<boolean> {
  const owner = await readRepositoryLockOwner(lockDirectory);
  if (owner) {
    if (Date.now() - owner.createdAt <= REPOSITORY_LOCK_STALE_MS || isProcessAlive(owner.pid)) {
      return false;
    }
  } else {
    try {
      const lockStats = await stat(lockDirectory);
      if (Date.now() - lockStats.mtimeMs <= REPOSITORY_LOCK_STALE_MS) return false;
    } catch {
      return true;
    }
  }

  await rm(lockDirectory, { recursive: true, force: true });
  logger.warn('Removed stale repository merge lock', { lockDirectory, owner });
  return true;
}

async function acquireRepositoryMergeLock(commonDir: string): Promise<() => Promise<void>> {
  const lockDirectory = join(commonDir, REPOSITORY_LOCK_DIRECTORY);
  const token = randomUUID();
  const deadline = Date.now() + REPOSITORY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(
        join(lockDirectory, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })
      );
      return async () => {
        const owner = await readRepositoryLockOwner(lockDirectory);
        if (owner?.token === token) {
          await rm(lockDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (await removeStaleRepositoryLock(lockDirectory)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for repository merge lock: ${lockDirectory}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

export interface MergeOptions {
  squash?: boolean;
  message?: string;
  deleteWorktreeAndBranch?: boolean;
  /** Remote name to fetch from before merging (defaults to 'origin') */
  remote?: string;
  /**
   * When bringing the target into the feature branch conflicts, leave the
   * conflicted merge in the feature worktree (instead of aborting) so an agent
   * can resolve it. The result then has conflictsInWorktree: true.
   */
  resolveConflictsInWorktree?: boolean;
}

export interface MergeServiceResult {
  success: boolean;
  error?: string;
  hasConflicts?: boolean;
  conflictFiles?: string[];
  /** The conflicted merge is left in the feature worktree for resolution. */
  conflictsInWorktree?: boolean;
  mergedBranch?: string;
  targetBranch?: string;
  deleted?: {
    worktreeDeleted: boolean;
    branchDeleted: boolean;
  };
}

/**
 * Perform a git merge operation directly without HTTP.
 *
 * @param projectPath - Path to the git repository
 * @param branchName - Source branch to merge
 * @param worktreePath - Path to the worktree (used for deletion if requested)
 * @param targetBranch - Branch to merge into; defaults to the project's integration branch
 *   (the branch checked out in the project folder)
 * @param options - Merge options
 * @param options.squash - If true, perform a squash merge
 * @param options.message - Custom merge commit message
 * @param options.deleteWorktreeAndBranch - If true, delete worktree and branch after merge
 * @param options.remote - Remote name to fetch from before merging (defaults to 'origin')
 */
export async function performMerge(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  targetBranch?: string,
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  const mergeTo = targetBranch || (await getIntegrationBranch(projectPath));
  let identity: RepositoryIdentity | null = null;
  let lockKey: string;
  try {
    identity = await resolveRepositoryIdentity(projectPath);
    lockKey = identity.key;
  } catch {
    const fallback = normalize(resolve(projectPath));
    lockKey = process.platform === 'win32' ? fallback.toLowerCase() : fallback;
  }
  return mergeMutex.run(lockKey, async () => {
    const releaseRepositoryLock = identity
      ? await acquireRepositoryMergeLock(identity.commonDir)
      : null;
    try {
      return await performMergeLocked(
        projectPath,
        branchName,
        worktreePath,
        mergeTo,
        options,
        emitter
      );
    } finally {
      await releaseRepositoryLock?.();
    }
  });
}

async function performMergeLocked(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  targetBranch: string,
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  if (!projectPath || !branchName || !worktreePath) {
    return {
      success: false,
      error: 'projectPath, branchName, and worktreePath are required',
    };
  }

  const mergeTo = targetBranch;

  // Validate branch names early to reject invalid input before any git operations
  if (!isValidBranchName(branchName)) {
    return {
      success: false,
      error: `Invalid source branch name: "${branchName}"`,
    };
  }
  if (!isValidBranchName(mergeTo)) {
    return {
      success: false,
      error: `Invalid target branch name: "${mergeTo}"`,
    };
  }
  if (branchName === mergeTo || branchName === 'main' || branchName === 'master') {
    return {
      success: false,
      error: `Source branch "${branchName}" cannot be integrated as a feature branch`,
    };
  }

  // Validate source branch exists (using safe array-based command)
  try {
    await execGitCommand(
      ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`],
      projectPath
    );
  } catch {
    return {
      success: false,
      error: `Branch "${branchName}" does not exist`,
    };
  }

  // Validate target branch exists (using safe array-based command)
  try {
    await execGitCommand(['rev-parse', '--verify', `refs/heads/${mergeTo}^{commit}`], projectPath);
  } catch {
    return {
      success: false,
      error: `Target branch "${mergeTo}" does not exist`,
    };
  }

  // Validate the remote name to prevent git option injection.
  // Reject invalid remote names so the caller knows their input was wrong,
  // consistent with how invalid branch names are handled above.
  const remote = options?.remote || 'origin';
  if (!isValidRemoteName(remote)) {
    logger.warn('Invalid remote name supplied to merge-service', {
      remote,
      projectPath,
    });
    return {
      success: false,
      error: `Invalid remote name: "${remote}"`,
    };
  }

  // Agents frequently finish their run without committing: the branch stays
  // identical to its base and merging it is a silent no-op while the actual
  // work sits uncommitted in the worktree. Commit any pending work on the
  // feature branch first so the merge carries the real changes.
  try {
    const checkedOutBranch = (
      await execGitCommand(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath)
    ).trim();
    if (checkedOutBranch !== branchName) {
      return {
        success: false,
        error: `Worktree is on "${checkedOutBranch}", not source branch "${branchName}"`,
      };
    }

    const pending = await execGitCommand(['status', '--porcelain'], worktreePath);
    if (getRelevantStatusLines(pending).length > 0) {
      await execGitCommand(
        [
          'add',
          '-A',
          '--',
          '.',
          ':(exclude).aboardai',
          ':(exclude).aboardai/**',
          ':(exclude).worktrees',
          ':(exclude).worktrees/**',
        ],
        worktreePath
      );
      await execGitCommand(
        ['commit', '-m', `[feature] ${branchName}: agent work auto-committed at merge`],
        worktreePath
      );
      logger.info('Committed pending worktree changes before merge', {
        branchName,
        worktreePath,
      });
    }
  } catch (commitError) {
    const errorMessage = `Failed to commit pending worktree changes before merge: ${(commitError as Error).message}`;
    logger.warn('Failed to auto-commit pending worktree changes before merge', {
      branchName,
      worktreePath,
      error: (commitError as Error).message,
    });
    emitter?.emit('merge:error', {
      branchName,
      targetBranch: mergeTo,
      error: errorMessage,
    });
    return {
      success: false,
      error: errorMessage,
    };
  }

  // Fetch latest from remote before merging to ensure we have up-to-date refs
  try {
    await execGitCommand(['fetch', remote], projectPath);
  } catch (fetchError) {
    logger.warn('Failed to fetch from remote before merge; proceeding with local refs', {
      remote,
      projectPath,
      error: (fetchError as Error).message,
    });
    // Non-fatal: proceed with local refs if fetch fails (e.g. offline)
  }

  // Bring the target into the feature branch first, inside the feature
  // worktree. Conflicts then surface where the feature's own agent can resolve
  // them, and the merge into the target is a clean fast-forward that never
  // leaves the target checkout half-merged.
  try {
    const targetAlreadyIncluded = await execGitCommand(
      ['merge-base', '--is-ancestor', mergeTo, 'HEAD'],
      worktreePath
    )
      .then(() => true)
      .catch(() => false);
    if (!targetAlreadyIncluded) {
      try {
        await execGitCommand(
          ['merge', mergeTo, '-m', `Merge ${mergeTo} into ${branchName} before integration`],
          worktreePath,
          { LC_ALL: 'C' }
        );
      } catch (syncError) {
        const conflictFiles = await listConflictFiles(worktreePath);
        if (conflictFiles.length === 0) throw syncError;
        emitter?.emit('merge:conflict', { branchName, targetBranch: mergeTo, conflictFiles });
        if (!options?.resolveConflictsInWorktree) {
          await execGitCommand(['merge', '--abort'], worktreePath).catch(() => {});
        }
        return {
          success: false,
          error: `Merge CONFLICT: bringing "${mergeTo}" into "${branchName}" conflicts in ${conflictFiles.length} file(s).`,
          hasConflicts: true,
          conflictFiles,
          conflictsInWorktree: options?.resolveConflictsInWorktree === true,
        };
      }
    }
  } catch (syncError) {
    const errorMessage = `Failed to bring "${mergeTo}" into "${branchName}": ${(syncError as Error).message}`;
    emitter?.emit('merge:error', { branchName, targetBranch: mergeTo, error: errorMessage });
    return { success: false, error: errorMessage };
  }

  let mergeWorkspace: MergeWorkspace | null = null;
  try {
    mergeWorkspace = await resolveMergeWorkspace(projectPath, mergeTo);
  } catch (workspaceError) {
    const errorMessage =
      workspaceError instanceof Error ? workspaceError.message : String(workspaceError);
    emitter?.emit('merge:error', {
      branchName,
      targetBranch: mergeTo,
      error: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
  const mergeProjectPath = mergeWorkspace.path;
  let mergeWorkspaceFinalized = false;

  try {
    // Emit merge:start after validating inputs
    emitter?.emit('merge:start', { branchName, targetBranch: mergeTo, worktreePath });

    // Merge the feature branch into the target branch (using safe array-based commands)
    const mergeMessage = options?.message || `Merge ${branchName} into ${mergeTo}`;
    const mergeArgs = options?.squash
      ? ['merge', '--squash', branchName]
      : mergeWorkspace.dirty
        ? ['merge', '--ff-only', branchName]
        : ['merge', branchName, '-m', mergeMessage];

    try {
      // Set LC_ALL=C so git always emits English output regardless of the system
      // locale, making text-based conflict detection reliable.
      await execGitCommand(mergeArgs, mergeProjectPath, { LC_ALL: 'C' });
    } catch (mergeError: unknown) {
      // Check if this is a merge conflict.  We use a multi-layer strategy so
      // that detection is reliable even when locale settings vary or git's text
      // output changes across versions:
      //
      //  1. Primary (text-based): scan the error output for well-known English
      //     conflict markers.  Because we pass LC_ALL=C above these strings are
      //     always in English, but we keep the check as one layer among several.
      //
      //  2. Unmerged-path check: run `git diff --name-only --diff-filter=U`
      //     (locale-stable) and treat any non-empty output as a conflict
      //     indicator, capturing the file list at the same time.
      //
      //  3. Fallback status check: run `git status --porcelain` and look for
      //     lines whose first two characters indicate an unmerged state
      //     (UU, AA, DD, AU, UA, DU, UD).
      //
      // hasConflicts is true when ANY of the three layers returns positive.
      const err = mergeError as { stdout?: string; stderr?: string; message?: string };
      const output = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;

      // Layer 1 – text matching (locale-safe because we set LC_ALL=C above).
      const textIndicatesConflict =
        output.includes('CONFLICT') || output.includes('Automatic merge failed');

      // Layers 2 & 3 – repository state inspection (locale-independent).
      // Layer 2: get conflicted files via diff (also locale-stable output).
      let conflictFiles: string[] | undefined;
      let diffIndicatesConflict = false;
      try {
        const diffOutput = await execGitCommand(
          ['diff', '--name-only', '--diff-filter=U'],
          mergeProjectPath,
          { LC_ALL: 'C' }
        );
        const files = diffOutput
          .trim()
          .split('\n')
          .filter((f) => f.trim().length > 0);
        if (files.length > 0) {
          diffIndicatesConflict = true;
          conflictFiles = files;
        }
      } catch {
        // If we can't get the file list, leave conflictFiles undefined so callers
        // can distinguish "no conflicts" (empty array) from "unknown due to diff failure" (undefined)
      }

      // Layer 3: check for unmerged paths via machine-readable git status.
      let hasUnmergedPaths = false;
      try {
        const statusOutput = await execGitCommand(['status', '--porcelain'], mergeProjectPath, {
          LC_ALL: 'C',
        });
        // Unmerged status codes occupy the first two characters of each line.
        // Standard unmerged codes: UU, AA, DD, AU, UA, DU, UD.
        const unmergedLines = statusOutput
          .split('\n')
          .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line));
        hasUnmergedPaths = unmergedLines.length > 0;

        // If Layer 2 did not populate conflictFiles (e.g. diff failed or returned
        // nothing) but Layer 3 does detect unmerged paths, parse the status lines
        // to extract filenames and assign them to conflictFiles so callers always
        // receive an accurate file list when conflicts are present.
        if (hasUnmergedPaths && conflictFiles === undefined) {
          const parsedFiles = unmergedLines
            .map((line) => line.slice(2).trim())
            .filter((f) => f.length > 0);
          // Deduplicate (e.g. rename entries can appear twice)
          conflictFiles = [...new Set(parsedFiles)];
        }
      } catch {
        // git status failing is itself a sign something is wrong; leave
        // hasUnmergedPaths as false and rely on the other layers.
      }

      const hasConflicts = textIndicatesConflict || diffIndicatesConflict || hasUnmergedPaths;

      if (hasConflicts) {
        // Emit merge:conflict event with conflict details
        emitter?.emit('merge:conflict', { branchName, targetBranch: mergeTo, conflictFiles });

        await abortMergeWorkspace(mergeWorkspace);
        await cleanupTemporaryMergeWorkspace(projectPath, mergeWorkspace);
        mergeWorkspaceFinalized = true;

        return {
          success: false,
          error: `Merge CONFLICT: Automatic merge of "${branchName}" into "${mergeTo}" failed and was safely aborted.`,
          hasConflicts: true,
          conflictFiles,
        };
      }

      // Emit merge:error for non-conflict errors before re-throwing
      emitter?.emit('merge:error', {
        branchName,
        targetBranch: mergeTo,
        error: err.message || String(mergeError),
      });

      // Re-throw non-conflict errors
      throw mergeError;
    }

    // If squash merge, need to commit (using safe array-based command)
    if (options?.squash) {
      const squashMessage = options?.message || `Merge ${branchName} (squash)`;
      try {
        await execGitCommand(['commit', '-m', squashMessage], mergeProjectPath);
      } catch (commitError: unknown) {
        const err = commitError as { message?: string };
        // Emit merge:error so subscribers always receive either merge:success or merge:error
        emitter?.emit('merge:error', {
          branchName,
          targetBranch: mergeTo,
          error: err.message || String(commitError),
        });
        throw commitError;
      }
    }

    await cleanupTemporaryMergeWorkspace(projectPath, mergeWorkspace);
    mergeWorkspaceFinalized = true;
  } finally {
    if (!mergeWorkspaceFinalized) {
      await abortMergeWorkspace(mergeWorkspace);
      await cleanupTemporaryMergeWorkspace(projectPath, mergeWorkspace);
    }
  }

  // Optionally delete the worktree and branch after merging
  let worktreeDeleted = false;
  let branchDeleted = false;

  if (options?.deleteWorktreeAndBranch) {
    let checkoutIsClean = false;
    try {
      const status = await execGitCommand(['status', '--porcelain'], worktreePath, {
        LC_ALL: 'C',
      });
      checkoutIsClean = getRelevantStatusLines(status).length === 0;
      if (!checkoutIsClean) {
        logger.warn(`Retaining dirty merged worktree and branch: ${worktreePath}`);
      }
    } catch (statusError) {
      logger.warn(`Could not verify merged worktree is clean; retaining it: ${worktreePath}`, {
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
    }

    if (checkoutIsClean) {
      try {
        await execGitCommand(['worktree', 'remove', worktreePath], projectPath);
        worktreeDeleted = true;
      } catch {
        try {
          await execGitCommand(['worktree', 'prune'], projectPath);
        } catch {
          // Pruning stale metadata is best-effort and never proves deletion.
        }
        logger.warn(`Failed to safely remove worktree: ${worktreePath}`);
      }
    }

    // Delete only a merged branch whose clean checkout was safely removed.
    if (worktreeDeleted && branchName !== 'main' && branchName !== 'master') {
      try {
        await execGitCommand(['branch', '-d', branchName], projectPath);
        branchDeleted = true;
      } catch {
        logger.warn(`Failed to delete branch: ${branchName}`);
      }
    }
  }

  // Emit merge:success with merged branch, target branch, and deletion info
  emitter?.emit('merge:success', {
    mergedBranch: branchName,
    targetBranch: mergeTo,
    deleted: options?.deleteWorktreeAndBranch ? { worktreeDeleted, branchDeleted } : undefined,
  });

  return {
    success: true,
    mergedBranch: branchName,
    targetBranch: mergeTo,
    deleted: options?.deleteWorktreeAndBranch ? { worktreeDeleted, branchDeleted } : undefined,
  };
}
