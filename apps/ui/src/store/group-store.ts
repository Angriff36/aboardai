import { create } from 'zustand';
import type { TaskGroupSnapshot } from '@aboardai/types';
import { getHttpApiClient } from '@/lib/http-api-client';

interface GroupStoreState {
  groups: TaskGroupSnapshot[];
  loading: boolean;
  error: string | null;
}

interface GroupStoreActions {
  refresh(projectPath: string): Promise<void>;
  upsertGroup(group: TaskGroupSnapshot): void;
  registerGroupEvents(projectPath: string): () => void;
}

export const useGroupStore = create<GroupStoreState & GroupStoreActions>()((set, get) => ({
  groups: [],
  loading: false,
  error: null,

  refresh: async (projectPath: string) => {
    set({ loading: true, error: null });
    try {
      const api = getHttpApiClient();
      const result = await api.groups.list(projectPath);
      if (result.success && result.groups) {
        set({ groups: result.groups, loading: false });
      } else {
        set({ loading: false, error: result.error ?? 'Failed to load groups' });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load groups' });
    }
  },

  upsertGroup: (group: TaskGroupSnapshot) => {
    const { groups } = get();
    const idx = groups.findIndex((g) => g.id === group.id);
    if (idx >= 0) {
      const updated = [...groups];
      updated[idx] = group;
      set({ groups: updated });
    } else {
      set({ groups: [group, ...groups] });
    }
  },

  registerGroupEvents: (projectPath: string): (() => void) => {
    const api = getHttpApiClient();
    const unsub = api.groups.onGroupEvent(async (payload) => {
      const { groupId } = payload;
      const result = await api.groups.get(projectPath, groupId);
      if (result.success && result.group) {
        get().upsertGroup(result.group);
      }
    });
    return unsub;
  },
}));
