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

  const explicitlyIsolated = feature.worktreeMode === 'isolated';
  return {
    worktreeMode: 'isolated',
    branchName:
      explicitlyIsolated && feature.branchName
        ? feature.branchName
        : createFeatureBranchName(feature.id, feature.title),
    worktreeBaseBranch:
      feature.worktreeBaseBranch ??
      (!explicitlyIsolated ? feature.branchName : undefined) ??
      baseBranch,
  };
}

export function normalizeFeatureWorktreeAssignment(
  feature: Pick<Feature, 'id' | 'title' | 'worktreeMode' | 'branchName' | 'worktreeBaseBranch'>,
  primaryBranch: string
): FeatureWorktreeAssignment {
  if (feature.worktreeMode) {
    return buildDefaultWorktreeAssignment(feature, primaryBranch);
  }

  return {
    worktreeMode: 'isolated',
    branchName: createFeatureBranchName(feature.id, feature.title),
    worktreeBaseBranch: feature.branchName ?? primaryBranch,
  };
}
