import { describe, it, expect } from 'vitest';
import { groupTrajectory } from '../../../src/lib/trajectory-grouping';
import type { NormalizedEvent } from '@aboardai/types';

const ev = (
  id: string,
  kind: NormalizedEvent['kind'],
  extra: Partial<NormalizedEvent> = {}
): NormalizedEvent => ({ v: 1, id, ts: id, kind, provider: 'claude', ...extra });

describe('groupTrajectory', () => {
  it('puts pre-marker events in an Activity group', () => {
    const groups = groupTrajectory([
      ev('1', 'agent_message', { text: 'hi' }),
      ev('2', 'command_run', { command: { command: 'ls' } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Activity');
    expect(groups[0].events).toHaveLength(2);
  });

  it('starts a new group on task_start and marks done on task_complete', () => {
    const groups = groupTrajectory([
      ev('1', 'task_marker', { marker: { type: 'task_start', taskId: 'T001' } }),
      ev('2', 'command_run', { command: { command: 'npm test' } }),
      ev('3', 'task_marker', {
        marker: { type: 'task_complete', taskId: 'T001', summary: 'done' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('T001');
    expect(groups[0].done).toBe(true);
    expect(groups[0].summary).toBe('done');
    expect(groups[0].events).toHaveLength(1);
  });

  it('gives auto-generated unique keys to consecutive task_start markers without taskId', () => {
    const groups = groupTrajectory([
      ev('1', 'task_marker', { marker: { type: 'task_start' } }),
      ev('2', 'agent_message', { text: 'a' }),
      ev('3', 'task_marker', { marker: { type: 'task_start' } }),
      ev('4', 'agent_message', { text: 'b' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).not.toBe(groups[1].key);
    expect(groups[0].key).toBe('__auto-task-1');
    expect(groups[1].key).toBe('__auto-task-2');
  });

  it('marks the leading Activity group done when task_complete arrives with no prior task_start', () => {
    const groups = groupTrajectory([
      ev('1', 'agent_message', { text: 'hi' }),
      ev('2', 'task_marker', { marker: { type: 'task_complete', summary: 's' } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Activity');
    expect(groups[0].done).toBe(true);
    expect(groups[0].summary).toBe('s');
  });
});
