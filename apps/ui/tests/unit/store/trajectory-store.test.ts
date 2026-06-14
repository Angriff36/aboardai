import { describe, it, expect, beforeEach } from 'vitest';
import { useTrajectoryStore } from '../../../src/store/trajectory-store';
import type { NormalizedEvent } from '@aboardai/types';

const ev = (id: string, ts: string): NormalizedEvent => ({
  v: 1,
  id,
  ts,
  kind: 'agent_message',
  provider: 'claude',
  text: 'x',
});

describe('useTrajectoryStore', () => {
  beforeEach(() => useTrajectoryStore.setState({ eventsByFeature: {} }));

  it('appends events and dedupes by id:ts', () => {
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1'));
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1')); // dup
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't2')); // same id, diff ts → kept
    expect(useTrajectoryStore.getState().eventsByFeature['f1']).toHaveLength(2);
  });

  it('clear removes a feature', () => {
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1'));
    useTrajectoryStore.getState().clear('f1');
    expect(useTrajectoryStore.getState().eventsByFeature['f1']).toBeUndefined();
  });
});
