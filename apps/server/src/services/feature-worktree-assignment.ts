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

const FEATURE_INTEGRATION_BRANCH = 'main';

export function createFeatureBranchName(featureId: string, title?: string): string {
  const identity = createHash('sha256').update(featureId).digest('hex').slice(0, 8);
  return `feature/${branchSlug(title)}-${identity}`;
}

export function buildDefaultWorktreeAssignment(
  feature: Pick<Feature, 'id' | 'title' | 'worktreeMode' | 'branchName' | 'worktreeBaseBranch'>,
  _baseBranch?: string | null
): FeatureWorktreeAssignment {
  if (feature.worktreeMode === 'shared') {
    return {
      worktreeMode: 'shared',
      branchName: feature.branchName,
      worktreeBaseBranch: undefined,
    };
  }

  const explicitlyIsolated = feature.worktreeMode === 'isolated';
  return {
    worktreeMode: 'isolated',
    branchName:
      explicitlyIsolated && feature.branchName
        ? feature.branchName
        : createFeatureBranchName(feature.id, feature.title),
    // Feature isolation is never allowed to turn the currently selected
    // worktree into a long-lived integration branch. All feature branches
    // start from and ultimately merge back into literal main.
    worktreeBaseBranch: FEATURE_INTEGRATION_BRANCH,
  };
}

export function normalizeFeatureWorktreeAssignment(
  feature: Pick<Feature, 'id' | 'title' | 'worktreeMode' | 'branchName' | 'worktreeBaseBranch'>,
  _primaryBranch: string
): FeatureWorktreeAssignment {
  if (feature.worktreeMode) {
    return buildDefaultWorktreeAssignment(feature, FEATURE_INTEGRATION_BRANCH);
  }

  return {
    worktreeMode: 'isolated',
    branchName: createFeatureBranchName(feature.id, feature.title),
    worktreeBaseBranch: FEATURE_INTEGRATION_BRANCH,
  };
}
