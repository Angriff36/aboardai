import { execGitCommand } from '@aboardai/git-utils';

/**
 * The branch feature work starts from and merges back into: the branch checked
 * out in the project folder (e.g. `dev`). Falls back to `main` when the folder
 * is not on a branch.
 */
export async function getIntegrationBranch(projectPath: string): Promise<string> {
  try {
    const branch = (
      await execGitCommand(['symbolic-ref', '--quiet', '--short', 'HEAD'], projectPath)
    ).trim();
    if (branch) return branch;
  } catch {
    // Detached HEAD or not a git repository.
  }
  return 'main';
}
