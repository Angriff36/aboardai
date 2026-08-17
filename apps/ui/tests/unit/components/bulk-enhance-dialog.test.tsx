import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BulkEnhanceDialog } from '@/components/views/board-view/dialogs/bulk-enhance-dialog';
import type { BulkEnhancementProgress } from '@/components/views/board-view/shared/enhancement/bulk-enhancement';

vi.mock('@/components/shared', () => ({
  ModelOverrideTrigger: () => <button aria-label="Change enhancement model">Sonnet</button>,
  useModelOverride: () => ({
    effectiveModelEntry: { model: 'claude-sonnet', thinkingLevel: 'none' },
    effectiveModel: 'claude-sonnet',
    isOverridden: false,
    setOverride: vi.fn(),
    clearOverride: vi.fn(),
    globalDefault: { model: 'claude-sonnet', thinkingLevel: 'none' },
    override: null,
  }),
}));

describe('BulkEnhanceDialog', () => {
  it('runs the unchanged default mode and shows live progress through completion', async () => {
    const user = userEvent.setup();
    const onFinished = vi.fn();
    let finishRun!: (value: {
      succeededIds: string[];
      failures: Array<{ featureId: string; error: string }>;
    }) => void;
    const pendingRun = new Promise<{
      succeededIds: string[];
      failures: Array<{ featureId: string; error: string }>;
    }>((resolve) => {
      finishRun = resolve;
    });
    const onRun = vi.fn(
      async (_options: unknown, onProgress: (progress: BulkEnhancementProgress) => void) => {
        onProgress({ completed: 1, total: 3, failed: 0 });
        return pendingRun;
      }
    );

    render(
      <BulkEnhanceDialog
        open
        featureCount={3}
        featureNames={{}}
        onOpenChange={vi.fn()}
        onRun={onRun}
        onFinished={onFinished}
      />
    );

    expect(screen.getByRole('heading', { name: 'Enhance 3 Features' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Improve Clarity/ })).toBeInTheDocument();

    await user.click(screen.getByTestId('bulk-enhance-start-button'));

    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'improve' }),
      expect.any(Function),
      undefined
    );
    expect(await screen.findByText('1 of 3 features enhanced')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    finishRun({ succeededIds: ['feature-1', 'feature-2', 'feature-3'], failures: [] });

    expect(await screen.findByText('All 3 features enhanced')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  });

  it('names failed features and retries only those items', async () => {
    const user = userEvent.setup();
    const onFinished = vi.fn();
    const onRun = vi
      .fn()
      .mockResolvedValueOnce({
        succeededIds: ['feature-1'],
        failures: [{ featureId: 'feature-2', error: 'provider failed' }],
      })
      .mockResolvedValueOnce({ succeededIds: ['feature-2'], failures: [] });

    const view = render(
      <BulkEnhanceDialog
        open
        featureCount={2}
        featureNames={{ 'feature-1': 'First feature', 'feature-2': 'Checkout clarity' }}
        onOpenChange={vi.fn()}
        onRun={onRun}
        onFinished={onFinished}
      />
    );

    await user.click(screen.getByTestId('bulk-enhance-start-button'));

    expect(await screen.findByText('Checkout clarity')).toBeInTheDocument();
    expect(screen.getByText('provider failed')).toBeInTheDocument();

    view.rerender(
      <BulkEnhanceDialog
        open
        featureCount={1}
        featureNames={{ 'feature-2': 'Checkout clarity' }}
        onOpenChange={vi.fn()}
        onRun={onRun}
        onFinished={onFinished}
      />
    );
    expect(screen.getByRole('heading', { name: 'Enhance 2 Features' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry Failed' }));

    expect(onRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'improve' }),
      expect.any(Function),
      ['feature-2']
    );
    expect(await screen.findByText('All 1 feature enhanced')).toBeInTheDocument();
  });
});
