import { create } from 'zustand';
import type { NormalizedEvent } from '@aboardai/types';
import { getHttpApiClient } from '@/lib/http-api-client';

const dedupeKey = (e: NormalizedEvent): string => `${e.id}:${e.ts}`;

interface TrajectoryStoreState {
  eventsByFeature: Record<string, NormalizedEvent[]>;
}

interface TrajectoryStoreActions {
  load(projectPath: string, featureId: string): Promise<void>;
  appendEvent(featureId: string, event: NormalizedEvent): void;
  registerFeatureEvents(): () => void;
  clear(featureId: string): void;
}

export const useTrajectoryStore = create<TrajectoryStoreState & TrajectoryStoreActions>()(
  (set, get) => ({
    eventsByFeature: {},

    load: async (projectPath: string, featureId: string) => {
      const api = getHttpApiClient();
      const res = await api.features.getEvents(projectPath, featureId);
      if (res.success && res.events) {
        set((s) => ({ eventsByFeature: { ...s.eventsByFeature, [featureId]: res.events! } }));
      }
    },

    appendEvent: (featureId: string, event: NormalizedEvent) => {
      const cur = get().eventsByFeature[featureId] ?? [];
      const key = dedupeKey(event);
      if (cur.some((e) => dedupeKey(e) === key)) return;
      set((s) => ({ eventsByFeature: { ...s.eventsByFeature, [featureId]: [...cur, event] } }));
    },

    registerFeatureEvents: (): (() => void) => {
      const api = getHttpApiClient();
      return api.features.onFeatureEvent((payload) => {
        get().appendEvent(payload.featureId, payload.event);
      });
    },

    clear: (featureId: string) =>
      set((s) => {
        const next = { ...s.eventsByFeature };
        delete next[featureId];
        return { eventsByFeature: next };
      }),
  })
);
