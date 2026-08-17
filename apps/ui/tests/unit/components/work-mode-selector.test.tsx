import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkModeSelector } from '@/components/views/board-view/shared/work-mode-selector';
import { getDefaultWorkMode } from '@/components/views/board-view/dialogs/add-feature-dialog';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver);

const renderSelector = (workMode: 'current' | 'auto' | 'custom') => {
  const onWorkModeChange = vi.fn();
  render(
    <WorkModeSelector
      workMode={workMode}
      onWorkModeChange={onWorkModeChange}
      branchName="feature/shared"
      onBranchNameChange={vi.fn()}
      branchSuggestions={[]}
      currentBranch="develop"
    />
  );
  return onWorkModeChange;
};

describe('WorkModeSelector', () => {
  it('presents feature-owned isolation as the automatic mode', () => {
    renderSelector('auto');

    expect(screen.getByText('Isolated Worktree')).toBeInTheDocument();
    expect(screen.getByText(/created lazily when this feature starts/i)).toBeInTheDocument();
    expect(screen.getByText(/feature-owned worktree based on/i)).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
  });

  it.each(['current', 'custom'] as const)(
    'warns that %s mode shares and serializes work',
    (mode) => {
      renderSelector(mode);

      expect(screen.getByText(/shared checkout/i)).toBeInTheDocument();
      expect(screen.getByText(/wait their turn/i)).toBeInTheDocument();
    }
  );

  it('keeps manual shared branch choices available', () => {
    const onWorkModeChange = renderSelector('auto');

    fireEvent.click(screen.getByRole('button', { name: /current branch/i }));
    fireEvent.click(screen.getByRole('button', { name: /custom branch/i }));

    expect(onWorkModeChange).toHaveBeenNthCalledWith(1, 'current');
    expect(onWorkModeChange).toHaveBeenNthCalledWith(2, 'custom');
  });
});

describe('getDefaultWorkMode', () => {
  it('defaults to isolated mode whenever worktrees are enabled', () => {
    expect(getDefaultWorkMode(true)).toBe('auto');
    expect(getDefaultWorkMode(true, 'selected-worktree', true)).toBe('auto');
  });

  it('uses the current checkout when worktrees are disabled', () => {
    expect(getDefaultWorkMode(false)).toBe('current');
  });
});
