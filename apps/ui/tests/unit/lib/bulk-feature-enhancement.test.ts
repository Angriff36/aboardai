import { describe, expect, it, vi } from 'vitest';
import { executeBulkFeatureEnhancement } from '@/components/views/board-view/shared/enhancement/bulk-feature-enhancement';

describe('executeBulkFeatureEnhancement', () => {
  it('uses the existing prompt route and saves enhancement history for each feature', async () => {
    const enhance = vi.fn().mockResolvedValue({
      success: true,
      enhancedText: 'Clear rewrite',
    });
    const update = vi.fn().mockResolvedValue({ success: true });

    const result = await executeBulkFeatureEnhancement({
      projectPath: 'C:\\Projects\\example',
      features: [{ id: 'feature-1', description: 'Original' }],
      options: {
        mode: 'improve',
        model: 'claude-sonnet',
        thinkingLevel: 'none',
      },
      enhance,
      update,
    });

    expect(enhance).toHaveBeenCalledWith(
      'Original',
      'improve',
      'claude-sonnet',
      'none',
      'C:\\Projects\\example'
    );
    expect(update).toHaveBeenCalledWith(
      'C:\\Projects\\example',
      'feature-1',
      { description: 'Clear rewrite' },
      'enhance',
      'improve',
      'Original'
    );
    expect(result).toEqual({ succeededIds: ['feature-1'], failures: [] });
  });

  it('limits a retry to the supplied failed feature IDs', async () => {
    const enhance = vi.fn().mockResolvedValue({
      success: true,
      enhancedText: 'Retried rewrite',
    });
    const update = vi.fn().mockResolvedValue({ success: true });

    await executeBulkFeatureEnhancement({
      projectPath: 'C:\\Projects\\example',
      features: [
        { id: 'feature-1', description: 'Already saved' },
        { id: 'feature-2', description: 'Retry me' },
      ],
      featureIds: ['feature-2'],
      options: {
        mode: 'improve',
        model: 'claude-sonnet',
        thinkingLevel: 'none',
      },
      enhance,
      update,
    });

    expect(enhance).toHaveBeenCalledTimes(1);
    expect(enhance).toHaveBeenCalledWith(
      'Retry me',
      'improve',
      'claude-sonnet',
      'none',
      'C:\\Projects\\example'
    );
    expect(update).toHaveBeenCalledTimes(1);
  });
});
