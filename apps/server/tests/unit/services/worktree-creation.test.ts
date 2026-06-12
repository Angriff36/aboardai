/**
 * Tests for worktree-creation service.
 *
 * Tests the per-(projectPath, branchName) mutex that prevents double-create
 * races and the EEXIST fallback for cross-process races.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Module mocks (declared before imports) ────────────────────────────────

vi.mock('@/lib/git.js', () => ({
  execGitCommand: vi.fn(),
}));

vi.mock('@aboardai/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { execGitCommand } from '@/lib/git.js';
import { ensureWorktree, findExistingWorktreeForBranch } from '@/services/worktree-creation.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const PROJECT = '/fake/project';
const BRANCH = 'feature/my-branch';
const WORKTREE_PATH = `${PROJECT}/.worktrees/feature-my-branch`;

/**
 * Build the porcelain output that `git worktree list --porcelain` returns for
 * a single worktree entry.
 */
function buildPortelainOutput(p: string, b: string): string {
  return `worktree ${p}\nHEAD abc123\nbranch refs/heads/${b}\n\n`;
}

/**
 * Make execGitCommand return `output` for `worktree list --porcelain` calls,
 * and '' for all other calls (or the provided `defaultReturn`).
 */
function mockGitListOutput(output: string, defaultReturn = ''): void {
  (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      return output;
    }
    return defaultReturn;
  });
}

function mockGitListEmpty(): void {
  mockGitListOutput('');
}

function mockGitListFoundWorktree(p = WORKTREE_PATH, b = BRANCH): void {
  mockGitListOutput(buildPortelainOutput(p, b));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('findExistingWorktreeForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when worktree list is empty', async () => {
    (execGitCommand as unknown as Mock).mockResolvedValue('');
    const result = await findExistingWorktreeForBranch(PROJECT, BRANCH);
    expect(result).toBeNull();
  });

  it('returns the existing worktree when found', async () => {
    mockGitListFoundWorktree();
    const result = await findExistingWorktreeForBranch(PROJECT, BRANCH);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe(BRANCH);
    expect(result!.path).toContain('feature');
  });

  it('returns null for a different branch', async () => {
    mockGitListFoundWorktree(WORKTREE_PATH, 'some-other-branch');
    const result = await findExistingWorktreeForBranch(PROJECT, BRANCH);
    expect(result).toBeNull();
  });

  it('returns null when execGitCommand throws', async () => {
    (execGitCommand as unknown as Mock).mockRejectedValue(new Error('git error'));
    const result = await findExistingWorktreeForBranch(PROJECT, BRANCH);
    expect(result).toBeNull();
  });
});

describe('ensureWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path — worktree does not yet exist', () => {
    it('creates the worktree when branch already exists in git', async () => {
      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return ''; // not found
        if (args[0] === 'rev-parse') return ''; // branch exists
        if (args[0] === 'worktree' && args[1] === 'add') return ''; // add success
        return '';
      });

      const result = await ensureWorktree(PROJECT, BRANCH);

      expect(result.branch).toBe(BRANCH);
      expect(result.isNew).toBe(true);

      const calls = (execGitCommand as unknown as Mock).mock.calls;
      const addCall = calls.find(
        (c: string[][]) => c[0]?.[0] === 'worktree' && c[0]?.[1] === 'add' && !c[0]?.includes('-b')
      );
      expect(addCall).toBeDefined();
    });

    it('creates the worktree with -b when branch does not exist', async () => {
      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse') throw new Error('unknown revision'); // branch missing
        if (args[0] === 'worktree' && args[1] === 'add') return '';
        return '';
      });

      const result = await ensureWorktree(PROJECT, BRANCH, { baseBranch: 'main' });

      expect(result.isNew).toBe(true);

      const calls = (execGitCommand as unknown as Mock).mock.calls;
      const addCall = calls.find((c: string[][]) => c[0]?.includes('-b'));
      expect(addCall).toBeDefined();
      expect(addCall![0]).toContain('main');
    });

    it('falls back to HEAD when baseBranch is not supplied', async () => {
      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse') throw new Error('unknown revision');
        if (args[0] === 'worktree' && args[1] === 'add') return '';
        return '';
      });

      await ensureWorktree(PROJECT, BRANCH);

      const calls = (execGitCommand as unknown as Mock).mock.calls;
      const addCall = calls.find((c: string[][]) => c[0]?.includes('-b'));
      expect(addCall![0]).toContain('HEAD');
    });
  });

  describe('happy path — worktree already exists', () => {
    it('returns the existing worktree without calling git worktree add', async () => {
      mockGitListFoundWorktree();

      const result = await ensureWorktree(PROJECT, BRANCH);

      expect(result.isNew).toBe(false);

      const calls = (execGitCommand as unknown as Mock).mock.calls;
      const addCall = calls.find(
        (c: string[][]) => c[0]?.[0] === 'worktree' && c[0]?.[1] === 'add'
      );
      expect(addCall).toBeUndefined();
    });
  });

  describe('race fix — double-create (same projectPath + branch)', () => {
    it('`git worktree add` is invoked EXACTLY ONCE when two concurrent calls race', async () => {
      let addCallCount = 0;
      let addHasRun = false;

      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          // Return empty before first add, return found worktree after
          if (addHasRun) {
            return buildPortelainOutput(WORKTREE_PATH, BRANCH);
          }
          return '';
        }
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') {
          addCallCount++;
          addHasRun = true;
          return '';
        }
        return '';
      });

      const [r1, r2] = await Promise.all([
        ensureWorktree(PROJECT, BRANCH),
        ensureWorktree(PROJECT, BRANCH),
      ]);

      // Add must have been called exactly once
      expect(addCallCount).toBe(1);

      // Both callers must have a path back
      expect(r1.path).toBeTruthy();
      expect(r2.path).toBeTruthy();
    });

    it('allows concurrent creates for DIFFERENT branches', async () => {
      let addCallCount = 0;

      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') {
          addCallCount++;
          return '';
        }
        return '';
      });

      await Promise.all([
        ensureWorktree(PROJECT, 'feature/branch-a'),
        ensureWorktree(PROJECT, 'feature/branch-b'),
      ]);

      expect(addCallCount).toBe(2);
    });
  });

  describe('EEXIST fallback (cross-process race)', () => {
    it('re-resolves via findExistingWorktreeForBranch when `worktree add` reports "already exists"', async () => {
      let listCallCount = 0;

      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          listCallCount++;
          // Call 1: in-lock re-check → not found yet (cross-process race scenario)
          // Call 2: EEXIST re-resolve → found
          if (listCallCount >= 2) {
            return buildPortelainOutput(WORKTREE_PATH, BRANCH);
          }
          return '';
        }
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') {
          throw new Error("fatal: 'feature-my-branch' already exists");
        }
        return '';
      });

      const result = await ensureWorktree(PROJECT, BRANCH);

      expect(result.isNew).toBe(false);
      expect(result.path).toContain('feature');
    });

    it('re-resolves when worktree add reports "already checked out"', async () => {
      let listCallCount = 0;

      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          listCallCount++;
          if (listCallCount >= 2) {
            return buildPortelainOutput(WORKTREE_PATH, BRANCH);
          }
          return '';
        }
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') {
          throw new Error('fatal: branch is already checked out');
        }
        return '';
      });

      const result = await ensureWorktree(PROJECT, BRANCH);
      expect(result.isNew).toBe(false);
    });

    it('throws the original error when add fails with a non-EEXIST error', async () => {
      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') {
          throw new Error('fatal: some other git error');
        }
        return '';
      });

      await expect(ensureWorktree(PROJECT, BRANCH)).rejects.toThrow('some other git error');
    });
  });

  describe('dirSuffix option', () => {
    it('appends the suffix to the directory name', async () => {
      (execGitCommand as unknown as Mock).mockImplementation(async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') return '';
        if (args[0] === 'rev-parse') return '';
        if (args[0] === 'worktree' && args[1] === 'add') return '';
        return '';
      });

      await ensureWorktree(PROJECT, BRANCH, { dirSuffix: 'abc12345' });

      const calls = (execGitCommand as unknown as Mock).mock.calls;
      const addCall = calls.find(
        (c: string[][]) => c[0]?.[0] === 'worktree' && c[0]?.[1] === 'add' && !c[0]?.includes('-b')
      );
      const pathArg = addCall![0][2] as string;
      expect(pathArg).toMatch(/feature-my-branch-abc12345/);
    });
  });
});
