import { describe, expect, it, vi } from 'vitest';
import {
  composeEnhancedDescription,
  runBulkEnhancement,
  type BulkEnhancementProgress,
} from '@/components/views/board-view/shared/enhancement/bulk-enhancement';

describe('composeEnhancedDescription', () => {
  it('replaces the original description for rewrite modes', () => {
    expect(composeEnhancedDescription('Original', 'Clear rewrite', 'improve')).toBe(
      'Clear rewrite'
    );
    expect(composeEnhancedDescription('Original', 'Short rewrite', 'simplify')).toBe(
      'Short rewrite'
    );
  });

  it('keeps the original and appends generated content for additive modes', () => {
    expect(composeEnhancedDescription('Original ', ' Criteria ', 'acceptance')).toBe(
      'Original\n\nCriteria'
    );
  });
});

describe('runBulkEnhancement', () => {
  it('limits concurrency, saves successful descriptions, and isolates failures', async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const progress: BulkEnhancementProgress[] = [];
    const savedDescriptions: Array<{ featureId: string; description: string }> = [];

    const result = await runBulkEnhancement({
      features: [
        { id: 'feature-1', description: 'First' },
        { id: 'feature-2', description: 'Second' },
        { id: 'feature-3', description: 'Third' },
      ],
      mode: 'acceptance',
      concurrency: 2,
      enhance: async (feature) => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCalls -= 1;

        if (feature.id === 'feature-2') {
          return { success: false, error: 'provider failed' };
        }

        return { success: true, enhancedText: `Criteria for ${feature.id}` };
      },
      save: async (feature, description) => {
        savedDescriptions.push({ featureId: feature.id, description });
        return { success: true };
      },
      onProgress: (value) => progress.push(value),
    });

    expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    expect(maxConcurrentCalls).toBe(2);
    expect(savedDescriptions).toEqual([
      { featureId: 'feature-1', description: 'First\n\nCriteria for feature-1' },
      { featureId: 'feature-3', description: 'Third\n\nCriteria for feature-3' },
    ]);
    expect(result.succeededIds).toEqual(['feature-1', 'feature-3']);
    expect(result.failures).toEqual([{ featureId: 'feature-2', error: 'provider failed' }]);
    expect(progress.at(-1)).toEqual({ completed: 3, total: 3, failed: 1 });
  });

  it('reports save errors and empty enhancement responses as item failures', async () => {
    const save = vi.fn(async (feature: { id: string }) => ({
      success: feature.id !== 'feature-save-failure',
      error: feature.id === 'feature-save-failure' ? 'save failed' : undefined,
    }));

    const result = await runBulkEnhancement({
      features: [
        { id: 'feature-empty', description: 'Empty response' },
        { id: 'feature-save-failure', description: 'Cannot save' },
      ],
      mode: 'improve',
      enhance: async (feature) =>
        feature.id === 'feature-empty'
          ? { success: true, enhancedText: '   ' }
          : { success: true, enhancedText: 'Improved description' },
      save,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.succeededIds).toEqual([]);
    expect(result.failures).toEqual([
      { featureId: 'feature-empty', error: 'AI returned an empty description' },
      { featureId: 'feature-save-failure', error: 'save failed' },
    ]);
  });
});
