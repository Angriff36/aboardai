import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NormalizedEvent } from '@aboardai/types';

// Hoisted mock of the HTTP client so load() reads from a stubbed getEvents.
// The store imports getHttpApiClient via the '@/lib/http-api-client' alias.
vi.mock('@/lib/http-api-client', () => ({
  getHttpApiClient: () => ({
    features: {
      getEvents: vi.fn(async () => ({
        success: true,
        events: [
          { v: 1, id: 'hist1', ts: 't1', kind: 'agent_message', provider: 'claude', text: 'h1' },
          { v: 1, id: 'hist2', ts: 't2', kind: 'agent_message', provider: 'claude', text: 'h2' },
        ] as NormalizedEvent[],
      })),
    },
  }),
}));

import { useTrajectoryStore } from '../../../src/store/trajectory-store';

const ev = (id: string, ts: string): NormalizedEvent => ({
  v: 1,
  id,
  ts,
  kind: 'agent_message',
  provider: 'claude',
  text: 'x',
});

describe('useTrajectoryStore.load', () => {
  beforeEach(() => useTrajectoryStore.setState({ eventsByFeature: {} }));

  it('merges server history first then live tail, without losing live events', async () => {
    // A live event arrived before/while load runs.
    useTrajectoryStore.getState().appendEvent('f1', ev('live1', 't9'));

    await useTrajectoryStore.getState().load('/p', 'f1');

    const ids = useTrajectoryStore.getState().eventsByFeature['f1'].map((e) => e.id);
    expect(ids).toEqual(['hist1', 'hist2', 'live1']);
  });
});
