import { describe, expect, it } from 'vitest';
import type { Feature } from '@aboardai/types';
import {
  buildDefaultWorktreeAssignment,
  createFeatureBranchName,
  normalizeFeatureWorktreeAssignment,
} from '@/services/feature-worktree-assignment.js';

const feature = (overrides: Partial<Feature> = {}): Feature => ({
  id: 'feature-one',
  title: 'Build Login',
  category: 'Core',
  description: 'Implement login',
  ...overrides,
});

describe('feature worktree assignment', () => {
  it('gives duplicate titles distinct deterministic branches', () => {
    const first = buildDefaultWorktreeAssignment(feature({ id: 'feature-one' }), 'develop');
    const second = buildDefaultWorktreeAssignment(feature({ id: 'feature-two' }), 'develop');

    expect(first).toEqual({
      worktreeMode: 'isolated',
      branchName: createFeatureBranchName('feature-one', 'Build Login'),
      worktreeBaseBranch: 'develop',
    });
    expect(second.branchName).not.toBe(first.branchName);
  });

  it('keeps an isolated branch stable after its title changes', () => {
    const assignment = normalizeFeatureWorktreeAssignment(
      feature({
        title: 'A New Title',
        worktreeMode: 'isolated',
        branchName: 'feature/build-login-existing',
        worktreeBaseBranch: 'develop',
      }),
      'main'
    );

    expect(assignment.branchName).toBe('feature/build-login-existing');
    expect(assignment.worktreeBaseBranch).toBe('develop');
  });

  it('leaves explicit shared assignments unchanged', () => {
    expect(
      normalizeFeatureWorktreeAssignment(
        feature({ worktreeMode: 'shared', branchName: 'release/current' }),
        'main'
      )
    ).toEqual({
      worktreeMode: 'shared',
      branchName: 'release/current',
      worktreeBaseBranch: undefined,
    });
  });

  it.each(['main', 'legacy-feature-branch'])(
    'migrates a legacy %s assignment while retaining it as the base',
    (legacyBranch) => {
      const assignment = normalizeFeatureWorktreeAssignment(
        feature({ branchName: legacyBranch }),
        'main'
      );

      expect(assignment).toEqual({
        worktreeMode: 'isolated',
        branchName: createFeatureBranchName('feature-one', 'Build Login'),
        worktreeBaseBranch: legacyBranch,
      });
    }
  );
});
