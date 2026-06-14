import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventCard } from '../../../src/components/views/board-view/trajectory/event-card';
import { TrajectoryView } from '../../../src/components/views/board-view/trajectory/trajectory-view';
import type { NormalizedEvent } from '@aboardai/types';

const ev = (
  kind: NormalizedEvent['kind'],
  extra: Partial<NormalizedEvent> = {},
  id = '1'
): NormalizedEvent => ({ v: 1, id, ts: id, kind, provider: 'claude', ...extra });

describe('EventCard', () => {
  it('renders an edit card with diff add/del counts and expandable diff', () => {
    render(
      <EventCard
        event={ev('file_edit', {
          file: {
            path: 'a.ts',
            tool: 'Edit',
            diff: { unified: '- a\n+ b', adds: 1, dels: 1, truncated: false },
          },
        })}
      />
    );
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText(/\+1/)).toBeTruthy();
    expect(screen.getByText(/−1|−1|-1/)).toBeTruthy();
  });

  it('thinking is collapsed by default and expands on click', () => {
    render(<EventCard event={ev('thinking', { text: 'secret reasoning', thinkingChars: 16 })} />);
    expect(screen.queryByText('secret reasoning')).toBeNull();
    fireEvent.click(screen.getByText(/thinking/i));
    expect(screen.getByText('secret reasoning')).toBeTruthy();
  });
});

describe('TrajectoryView', () => {
  it('renders an empty state when there are no events', () => {
    render(<TrajectoryView events={[]} />);
    expect(screen.getByText(/no activity/i)).toBeTruthy();
  });

  it('renders grouped events', () => {
    render(<TrajectoryView events={[ev('command_run', { command: { command: 'ls' } })]} />);
    expect(screen.getByText('ls')).toBeTruthy();
  });
});
