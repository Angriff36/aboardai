import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await rm(directory, { recursive: true, force: true });
  }
});

describe('performMerge clean-only worktree cleanup', () => {
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
  });

  it('retains both the checkout and branch when the merged worktree is dirty', async () => {
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
      deleted: { worktreeDeleted: false, branchDeleted: false },
    });
    expect(await git(repository.projectPath, 'branch', '--list', repository.branchName)).toContain(
      repository.branchName
    );
    expect(await git(repository.worktreePath, 'status', '--porcelain')).toContain(
      'uncommitted.txt'
    );
  });
});
