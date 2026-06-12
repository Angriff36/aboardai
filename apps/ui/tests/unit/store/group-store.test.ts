import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGroupStore } from '../../../src/store/group-store';

vi.mock('@/lib/http-api-client', () => ({
  getHttpApiClient: vi.fn(),
}));

import { getHttpApiClient } from '../../../src/lib/http-api-client';

function makeGroup(
  overrides: Partial<import('@aboardai/types').TaskGroupSnapshot> = {}
): import('@aboardai/types').TaskGroupSnapshot {
  return {
    id: 'group-1',
    name: 'Group One',
    baseBranch: null,
    maxConcurrency: 3,
    retryLimit: 1,
    status: 'pending',
    children: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useGroupStore', () => {
  beforeEach(() => {
    useGroupStore.setState({ groups: [], loading: false, error: null });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('refresh', () => {
    it('sets groups from successful API response', async () => {
      const groups = [makeGroup({ id: 'g1' }), makeGroup({ id: 'g2' })];
      vi.mocked(getHttpApiClient).mockReturnValue({
        groups: {
          list: vi.fn().mockResolvedValue({ success: true, groups }),
          get: vi.fn(),
          onGroupEvent: vi.fn(),
        },
      } as ReturnType<typeof getHttpApiClient>);

      await useGroupStore.getState().refresh('/some/project');

      const state = useGroupStore.getState();
      expect(state.groups).toEqual(groups);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets error when API returns failure', async () => {
      vi.mocked(getHttpApiClient).mockReturnValue({
        groups: {
          list: vi.fn().mockResolvedValue({ success: false, error: 'Not found' }),
          get: vi.fn(),
          onGroupEvent: vi.fn(),
        },
      } as ReturnType<typeof getHttpApiClient>);

      await useGroupStore.getState().refresh('/some/project');

      const state = useGroupStore.getState();
      expect(state.groups).toEqual([]);
      expect(state.error).toBe('Not found');
      expect(state.loading).toBe(false);
    });

    it('sets error when API throws', async () => {
      vi.mocked(getHttpApiClient).mockReturnValue({
        groups: {
          list: vi.fn().mockRejectedValue(new Error('Network error')),
          get: vi.fn(),
          onGroupEvent: vi.fn(),
        },
      } as ReturnType<typeof getHttpApiClient>);

      await useGroupStore.getState().refresh('/some/project');

      const state = useGroupStore.getState();
      expect(state.error).toBe('Network error');
      expect(state.loading).toBe(false);
    });
  });

  describe('upsertGroup', () => {
    it('replaces an existing group with the same id', () => {
      const groupA = makeGroup({ id: 'g1', name: 'Original' });
      useGroupStore.setState({ groups: [groupA] });

      const updated = makeGroup({ id: 'g1', name: 'Updated' });
      useGroupStore.getState().upsertGroup(updated);

      const state = useGroupStore.getState();
      expect(state.groups).toHaveLength(1);
      expect(state.groups[0].name).toBe('Updated');
    });

    it('prepends a new group if id does not exist', () => {
      const groupA = makeGroup({ id: 'g1' });
      useGroupStore.setState({ groups: [groupA] });

      const groupB = makeGroup({ id: 'g2', name: 'New Group' });
      useGroupStore.getState().upsertGroup(groupB);

      const state = useGroupStore.getState();
      expect(state.groups).toHaveLength(2);
      expect(state.groups[0].id).toBe('g2');
      expect(state.groups[1].id).toBe('g1');
    });
  });

  describe('registerGroupEvents', () => {
    it('calls groups.get and upsertGroup when an event fires', async () => {
      const group = makeGroup({ id: 'g1', name: 'Updated via event' });
      let capturedCallback:
        | ((event: { projectPath: string; groupId: string; event: string }) => void)
        | null = null;

      const mockGet = vi.fn().mockResolvedValue({ success: true, group });
      vi.mocked(getHttpApiClient).mockReturnValue({
        groups: {
          list: vi.fn(),
          get: mockGet,
          onGroupEvent: vi.fn((cb) => {
            capturedCallback = cb;
            return () => {};
          }),
        },
      } as ReturnType<typeof getHttpApiClient>);

      useGroupStore.getState().registerGroupEvents('/my/project');

      // Simulate event firing
      expect(capturedCallback).not.toBeNull();
      await capturedCallback!({ projectPath: '/my/project', groupId: 'g1', event: 'updated' });

      expect(mockGet).toHaveBeenCalledWith('/my/project', 'g1');

      const state = useGroupStore.getState();
      expect(state.groups[0].name).toBe('Updated via event');
    });

    it('returns an unsubscribe function', () => {
      const mockUnsub = vi.fn();
      vi.mocked(getHttpApiClient).mockReturnValue({
        groups: {
          list: vi.fn(),
          get: vi.fn(),
          onGroupEvent: vi.fn().mockReturnValue(mockUnsub),
        },
      } as ReturnType<typeof getHttpApiClient>);

      const unsub = useGroupStore.getState().registerGroupEvents('/my/project');
      expect(typeof unsub).toBe('function');
      unsub();
      expect(mockUnsub).toHaveBeenCalled();
    });
  });
});
