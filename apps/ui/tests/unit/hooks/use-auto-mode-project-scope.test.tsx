import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoMode } from '@/hooks/use-auto-mode';
import { useAppStore } from '@/store/app-store';
import type { WorktreeInfo } from '@/components/views/board-view/worktree-panel/types';

const startAutoMode = vi.fn();

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({
    autoMode: {
      start: startAutoMode,
      stop: vi.fn(),
      status: vi.fn().mockResolvedValue({ success: true, isAutoLoopRunning: false }),
      stopFeature: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    },
  }),
}));

describe('useAutoMode project scope', () => {
  beforeEach(() => {
    startAutoMode.mockReset();
    startAutoMode.mockResolvedValue({ success: true });
    useAppStore.setState({
      currentProject: {
        id: 'archmage',
        name: 'Archmage',
        path: 'C:\\Projects\\archmage',
        isFavorite: false,
      },
      projects: [
        {
          id: 'archmage',
          name: 'Archmage',
          path: 'C:\\Projects\\archmage',
          isFavorite: false,
        },
      ],
      autoModeByWorktree: {},
      maxConcurrency: 3,
    });
  });

  it('starts the project dispatcher even when a feature worktree is selected', async () => {
    const selectedWorktree = {
      branch: 'feature/hero-recruitment-command-091c1f62',
      path: 'C:\\Projects\\archmage-worktrees\\hero-recruitment-command',
      isMain: false,
      isCurrent: true,
      hasWorktree: true,
    } as WorktreeInfo;

    const { result } = renderHook(() => useAutoMode(selectedWorktree));

    await act(async () => {
      await result.current.start();
    });

    expect(startAutoMode).toHaveBeenCalledWith('C:\\Projects\\archmage', null, 3);
  });
});
