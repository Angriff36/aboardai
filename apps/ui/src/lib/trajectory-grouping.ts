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
  let autoTaskCount = 0;

  const flush = () => {
    if (current.events.length > 0 || current.done) groups.push(current);
  };

  for (const e of events) {
    if (e.kind === 'task_marker' && e.marker) {
      if (e.marker.type === 'task_start') {
        flush();
        let key: string;
        let title: string;
        if (e.marker.taskId) {
          key = e.marker.taskId;
          title = e.marker.taskId;
        } else {
          autoTaskCount += 1;
          key = `__auto-task-${autoTaskCount}`; // prefixed so it can't collide with a real taskId
          title = `Task ${autoTaskCount}`;
        }
        current = { key, title, done: false, events: [] };
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
