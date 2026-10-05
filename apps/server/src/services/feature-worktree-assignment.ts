import { createHash } from 'node:crypto';
import type { Feature, FeatureWorktreeMode } from '@aboardai/types';

export interface FeatureWorktreeAssignment {
  worktreeMode: FeatureWorktreeMode;
  branchName: string | null | undefined;
  worktreeBaseBranch: string | null | undefined;
}

const branchSlug = (title?: string): string => {
  const slug = (title || 'feature')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return slug || 'feature';
};

export function createFeatureBranchName(featureId: string, title?: string): string {
  const identity = createHash('sha256').update(featureId).digest('hex').slice(0, 8);
  return `feature/${branchSlug(title)}-${identity}`;
}

export function buildDefaultWorktreeAssignment(
  feature: Pick<Feature, 'id' | 'title' | 'worktreeMode' | 'branchName' | 'worktreeBaseBranch'>,
  baseBranch?: string | null
): FeatureWorktreeAssignment {
  if (feature.worktreeMode === 'shared') {
    return {
      worktreeMode: 'shared',
      branchName: feature.branchName,
      worktreeBaseBranch: undefined,
    };
  }

  return {
    worktreeMode: 'isolated',
    branchName: createFeatureBranchName(feature.id, feature.title),
    // Feature branches start from and merge back into the project's
    // integration branch (the branch checked out in the project folder).
    // It is resolved at run time when not known yet.
    worktreeBaseBranch: baseBranch ?? undefined,
  };
}

export function normalizeFeatureWorktreeAssignment(
  feature: Pick<Feature, 'id' | 'title' | 'worktreeMode' | 'branchName' | 'worktreeBaseBranch'>,
  integrationBranch: string
): FeatureWorktreeAssignment {
  if (feature.worktreeMode === 'shared') {
    return buildDefaultWorktreeAssignment(feature, integrationBranch);
  }

  if (feature.worktreeMode === 'isolated') {
    // A branch built from an older base is brought onto the integration
    // branch by the pre-run refresh and the pre-merge sync; it is not an error.
    if (
      !feature.branchName ||
      feature.branchName === 'main' ||
      feature.branchName === 'master' ||
      feature.branchName === integrationBranch
    ) {
      throw new Error(
        'An isolated feature must use its own feature branch, not the integration branch.'
      );
    }
    return {
      worktreeMode: 'isolated',
      branchName: feature.branchName,
      worktreeBaseBranch: integrationBranch,
    };
  }

  return {
    worktreeMode: 'isolated',
    branchName: createFeatureBranchName(feature.id, feature.title),
    worktreeBaseBranch: integrationBranch,
  };
}
