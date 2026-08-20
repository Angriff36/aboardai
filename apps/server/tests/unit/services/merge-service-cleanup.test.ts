import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { performMerge } from '@/services/merge-service.js';

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createRepository(): Promise<{
  projectPath: string;
  worktreePath: string;
  branchName: string;
}> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'aboardai-merge-cleanup-'));
  tempDirectories.push(projectPath);
  await git(projectPath, 'init', '-b', 'main');
  await git(projectPath, 'config', 'user.email', 'tests@aboardai.local');
  await git(projectPath, 'config', 'user.name', 'AboardAI Tests');
  await writeFile(path.join(projectPath, 'README.md'), 'base\n');
  await git(projectPath, 'add', 'README.md');
  await git(projectPath, 'commit', '-m', 'base');

  const branchName = 'feature/cleanup-test';
  const worktreePath = `${projectPath}-worktree`;
  tempDirectories.push(worktreePath);
  await git(projectPath, 'worktree', 'add', '-b', branchName, worktreePath, 'main');
  await writeFile(path.join(worktreePath, 'feature.txt'), 'implemented\n');
  await git(worktreePath, 'add', 'feature.txt');
  await git(worktreePath, 'commit', '-m', 'implement feature');
  return { projectPath, worktreePath, branchName };
}

afterEach(async () => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('performMerge clean-only worktree cleanup', () => {
  it('merges into main without changing the branch checked out at the project path', async () => {
    const repository = await createRepository();
    await git(repository.projectPath, 'checkout', '-b', 'temp-feature');
    await writeFile(path.join(repository.projectPath, 'temp-only.txt'), 'do not merge here\n');
    await git(repository.projectPath, 'add', 'temp-only.txt');
    await git(repository.projectPath, 'commit', '-m', 'temp branch work');

    const result = await performMerge(
      repository.projectPath,
      repository.branchName,
      repository.worktreePath,
      'temp-feature'
    );

    expect(result).toMatchObject({ success: true, targetBranch: 'main' });
    expect(await git(repository.projectPath, 'branch', '--show-current')).toBe('temp-feature');
    expect(await git(repository.projectPath, 'ls-tree', '-r', '--name-only', 'main')).toContain(
      'feature.txt'
    );
    expect(
      await git(repository.projectPath, 'ls-tree', '-r', '--name-only', 'temp-feature')
    ).not.toContain('feature.txt');
  }, 15000);

  it('fails instead of merging into another branch when main does not exist', async () => {
    const repository = await createRepository();
    await git(repository.projectPath, 'branch', '-m', 'main', 'develop');

    const result = await performMerge(
      repository.projectPath,
      repository.branchName,
      repository.worktreePath,
      'develop'
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('main'),
    });
    expect(
      await git(repository.projectPath, 'ls-tree', '-r', '--name-only', 'develop')
    ).not.toContain('feature.txt');
  }, 15000);

  it('removes a clean merged feature worktree and branch', async () => {
    const repository = await createRepository();

    const result = await performMerge(
      repository.projectPath,
      repository.branchName,
      repository.worktreePath,
      'main',
      { deleteWorktreeAndBranch: true }
    );

    expect(result).toMatchObject({
      success: true,
      deleted: { worktreeDeleted: true, branchDeleted: true },
    });
    expect(await git(repository.projectPath, 'branch', '--list', repository.branchName)).toBe('');
    await expect(git(repository.worktreePath, 'status', '--porcelain')).rejects.toThrow();
  }, 15000);

  it('auto-commits dirty worktree changes so the merge carries them, then cleans up', async () => {
    const repository = await createRepository();
    await writeFile(path.join(repository.worktreePath, 'uncommitted.txt'), 'do not discard\n');

    const result = await performMerge(
      repository.projectPath,
      repository.branchName,
      repository.worktreePath,
      'main',
      { deleteWorktreeAndBranch: true }
    );

    expect(result).toMatchObject({
      success: true,
      deleted: { worktreeDeleted: true, branchDeleted: true },
    });
    // The previously-uncommitted work must have reached the target branch.
    expect(await git(repository.projectPath, 'ls-files', 'uncommitted.txt')).toContain(
      'uncommitted.txt'
    );
  }, 15000);

  it('fails integration when dirty worktree changes cannot be committed', async () => {
    const repository = await createRepository();
    await writeFile(path.join(repository.worktreePath, 'uncommitted.txt'), 'must not be omitted\n');
    const hooksDir = path.join(repository.projectPath, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const preCommitHook = path.join(hooksDir, 'pre-commit');
    await writeFile(preCommitHook, '#!/bin/sh\nexit 1\n');
    await chmod(preCommitHook, 0o755);

    const result = await performMerge(
      repository.projectPath,
      repository.branchName,
      repository.worktreePath,
      'main',
      { deleteWorktreeAndBranch: true }
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('commit pending worktree changes'),
    });
    expect(await git(repository.projectPath, 'ls-files', 'uncommitted.txt')).toBe('');
    expect(await git(repository.projectPath, 'branch', '--list', repository.branchName)).toContain(
      repository.branchName
    );
  }, 15000);
});
