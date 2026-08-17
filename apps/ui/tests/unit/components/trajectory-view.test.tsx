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

  it('shows truncation marker when thinkingTruncated is true', () => {
    render(
      <EventCard
        event={ev('thinking', {
          text: 'long reasoning...',
          thinkingChars: 4000,
          thinkingTruncated: true,
        })}
      />
    );
    // expand the card first
    fireEvent.click(screen.getByText(/thinking/i));
    expect(screen.getByText(/truncated/i)).toBeTruthy();
  });

  it('does not show truncation marker when thinkingTruncated is false', () => {
    render(
      <EventCard
        event={ev('thinking', {
          text: 'short reasoning',
          thinkingChars: 15,
          thinkingTruncated: false,
        })}
      />
    );
    fireEvent.click(screen.getByText(/thinking/i));
    expect(screen.queryByText(/truncated/i)).toBeNull();
  });

  it('summary event renders a "summary" pill label', () => {
    render(<EventCard event={ev('summary', { text: 'All done.' })} />);
    expect(screen.getByText('summary')).toBeTruthy();
  });

  // Regression: events persisted before the normalizer flattened array-shaped
  // tool_result content carry an object/array in `text`. Rendering that directly
  // throws React error #31. EventCard's asText() guard must coerce it to a string.
  it('renders tool_result whose text is an array of content blocks without crashing', () => {
    const text = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ] as unknown as string;
    render(<EventCard event={ev('tool_result', { text })} />);
    expect(screen.getByText('output')).toBeTruthy();
    expect(screen.getByText(/first[\s\S]*second/)).toBeTruthy();
  });

  it('renders agent_message whose text is a single content-block object without crashing', () => {
    const text = { type: 'text', text: 'hello world' } as unknown as string;
    render(<EventCard event={ev('agent_message', { text })} />);
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('file_edit diff is collapsed by default and expands on click', () => {
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
    // The diff body renders each unified line as its own <div>; '+ b' is not visible until expanded.
    expect(screen.queryByText('+ b')).toBeNull();
    // The path sits inside the toggle button, so clicking it expands the diff.
    fireEvent.click(screen.getByText('a.ts'));
    expect(screen.getByText('+ b')).toBeTruthy();
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

  it('done task group starts collapsed (inner events hidden)', () => {
    render(
      <TrajectoryView
        events={[
          ev('task_marker', { marker: { type: 'task_start', taskId: 'T001' } }, '1'),
          ev('command_run', { command: { command: 'ls' } }, '2'),
          ev(
            'task_marker',
            { marker: { type: 'task_complete', taskId: 'T001', summary: 'done' } },
            '3'
          ),
        ]}
      />
    );
    // The group header is present...
    expect(screen.getByTestId('phase-T001')).toBeTruthy();
    // ...but its inner event is not visible because done groups start collapsed.
    expect(screen.queryByText('ls')).toBeNull();
  });
});
