import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeWorktreeDialog } from '@/components/views/board-view/dialogs/merge-worktree-dialog';
import { getElectronAPI } from '@/lib/electron';
import type { WorktreeInfo } from '@/components/views/board-view/worktree-panel/types';

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock('@/lib/electron', () => ({ getElectronAPI: vi.fn() }));
vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const worktree: WorktreeInfo = {
  path: 'C:/repo/.worktrees/feature-one',
  branch: 'feature/one',
  isMain: false,
  isCurrent: false,
  hasWorktree: true,
  hasChanges: false,
};

describe('MergeWorktreeDialog', () => {
  beforeEach(() => {
    vi.mocked(getElectronAPI).mockReturnValue({
      worktree: {
        mergeFeature: vi.fn().mockResolvedValue({
          success: true,
          targetBranch: 'main',
          deleted: { worktreeDeleted: true, branchDeleted: false },
        }),
      },
    } as never);
  });

  it('reports the actual branch deletion result after a partial cleanup', async () => {
    const onIntegrated = vi.fn();
    render(
      <MergeWorktreeDialog
        open
        onOpenChange={vi.fn()}
        projectPath="C:/repo"
        worktree={worktree}
        onIntegrated={onIntegrated}
      />
    );

    fireEvent.click(screen.getByLabelText(/delete worktree and branch/i));
    fireEvent.click(screen.getByRole('button', { name: /^integrate$/i }));

    await waitFor(() => expect(onIntegrated).toHaveBeenCalledWith(worktree, false));
    expect(toastSuccess).toHaveBeenCalledWith(
      'Branch integrated into main',
      expect.objectContaining({ description: expect.stringMatching(/branch was retained/i) })
    );
  });
});
