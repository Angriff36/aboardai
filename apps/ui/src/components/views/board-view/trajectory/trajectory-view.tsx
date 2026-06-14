import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NormalizedEvent } from '@aboardai/types';
import { groupTrajectory } from '@/lib/trajectory-grouping';
import { EventCard } from './event-card';

export function TrajectoryView({ events }: { events: NormalizedEvent[] }) {
  // Hooks must run unconditionally, so compute groups before the empty-state early-return.
  const groups = useMemo(() => groupTrajectory(events), [events]);

  if (events.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">No activity recorded yet.</div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <PhaseGroup
          key={g.key}
          title={g.title}
          done={g.done}
          summary={g.summary}
          count={g.events.length}
        >
          {g.events.map((e) => (
            <EventCard key={`${e.id}:${e.ts}`} event={e} />
          ))}
        </PhaseGroup>
      ))}
    </div>
  );
}

function PhaseGroup({
  title,
  done,
  summary,
  count,
  children,
}: {
  title: string;
  done: boolean;
  summary?: string;
  count: number;
  children: ReactNode;
}) {
  // Done groups start collapsed; the active (not-done) group starts expanded.
  const [open, setOpen] = useState(!done);
  // Auto-collapse when a group transitions active→done while mounted (live task_complete).
  useEffect(() => {
    if (done) setOpen(false);
  }, [done]);
  return (
    <div className="rounded-lg border border-border">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-semibold bg-muted/50 rounded-t-lg"
        onClick={() => setOpen((o) => !o)}
        data-testid={`phase-${title}`}
      >
        <span className={done ? 'text-green-500' : 'text-muted-foreground'}>
          {done ? '✓' : '●'}
        </span>
        {title}
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {open ? '▾' : '▸'} {count} {count === 1 ? 'step' : 'steps'}
        </span>
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
      {!open && summary && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">{summary}</div>
      )}
    </div>
  );
}
