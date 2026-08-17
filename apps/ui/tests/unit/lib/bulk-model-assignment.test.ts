import { describe, expect, it, vi } from 'vitest';
import type { ModelAssignmentCandidate } from '@aboardai/types';
import { applyModelAssignments } from '@/components/views/board-view/shared/bulk-model-assignment';

const candidate: ModelAssignmentCandidate = {
  key: 'provider:zai:glm-5',
  model: 'glm-5',
  displayName: 'GLM 5',
  providerKey: 'claude-compatible:zai',
  providerLabel: 'Z.AI',
  providerId: 'zai',
  thinkingLevel: 'medium',
  isProviderDefault: true,
};

describe('applyModelAssignments', () => {
  it('limits concurrency, writes exact patches, and reports progress in input order', async () => {
    let active = 0;
    let maximum = 0;
    const progress: Array<{ completed: number; total: number; failed: number }> = [];
    const update = vi.fn(async (featureId: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (featureId === 'f2') throw new Error('write failed');
    });

    const result = await applyModelAssignments(
      ['f1', 'f2', 'f3'].map((featureId) => ({ featureId, candidate })),
      update,
      { concurrency: 2, onProgress: (value) => progress.push(value) }
    );

    expect(maximum).toBe(2);
    expect(update).toHaveBeenCalledWith('f1', {
      model: 'glm-5',
      providerId: 'zai',
      thinkingLevel: 'medium',
      reasoningEffort: undefined,
    });
    expect(result).toEqual({
      succeededIds: ['f1', 'f3'],
      failed: [{ featureId: 'f2', error: 'write failed' }],
    });
    expect(progress.at(-1)).toEqual({ completed: 3, total: 3, failed: 1 });
  });
});
