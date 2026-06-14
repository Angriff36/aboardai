import type { NormalizedEvent } from '@aboardai/types';

export interface TrajectoryGroup {
  key: string;
  title: string;
  done: boolean;
  summary?: string;
  events: NormalizedEvent[];
}

/** Group a flat event list into phase/task groups by task_marker boundaries. */
export function groupTrajectory(events: NormalizedEvent[]): TrajectoryGroup[] {
  const groups: TrajectoryGroup[] = [];
  let current: TrajectoryGroup = { key: 'activity', title: 'Activity', done: false, events: [] };

  const flush = () => {
    if (current.events.length > 0 || current.done) groups.push(current);
  };

  for (const e of events) {
    if (e.kind === 'task_marker' && e.marker) {
      if (e.marker.type === 'task_start') {
        flush();
        const id = e.marker.taskId ?? `task-${groups.length + 1}`;
        current = { key: id, title: id, done: false, events: [] };
      } else if (e.marker.type === 'task_complete') {
        current.done = true;
        if (e.marker.summary) current.summary = e.marker.summary;
      } else if (e.marker.type === 'phase_complete') {
        current.done = true;
      }
      continue;
    }
    current.events.push(e);
  }
  flush();
  return groups;
}
