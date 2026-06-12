/**
 * renderEventsToContext — unit tests
 *
 * Tests the pure renderer function that converts NormalizedEvent[] to a compact
 * text transcript for use in continuation prompts.
 *
 * Covers:
 *  - agent_message text is emitted verbatim
 *  - tool_use one-liner format "→ Tool(name): inputPreview"
 *  - file_edit "→ Edited: path"
 *  - command_run "→ Ran: command"
 *  - task_marker sentinel text reconstruction (TASK_START, TASK_COMPLETE, PHASE_COMPLETE)
 *  - status "[supervisor: status]" one-liner
 *  - result "--- [Result: ...] ---" at the end
 *  - error "--- [Error: ...] ---"
 *  - thinking / tool_result / summary / session are OMITTED
 *  - tail truncation at RENDER_MAX_CHARS with TRUNCATION_SENTINEL
 *  - empty input returns empty string
 */

import { describe, it, expect } from 'vitest';
import {
  renderEventsToContext,
  RENDER_MAX_CHARS,
  TRUNCATION_SENTINEL,
} from '../../../src/events/event-renderer.js';
import type { NormalizedEvent } from '@aboardai/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal NormalizedEvent of the given kind with overrides */
function evt(
  kind: NormalizedEvent['kind'],
  overrides: Partial<NormalizedEvent> = {}
): NormalizedEvent {
  return {
    v: 1,
    id: '0001',
    ts: '2026-01-01T00:00:00.000Z',
    kind,
    provider: 'claude',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite: basic rendering
// ---------------------------------------------------------------------------

describe('renderEventsToContext — basic rendering', () => {
  it('returns empty string for empty events array', () => {
    expect(renderEventsToContext([])).toBe('');
  });

  it('renders agent_message text verbatim', () => {
    const events = [evt('agent_message', { text: 'Hello, world!' })];
    const result = renderEventsToContext(events);
    expect(result).toBe('Hello, world!');
  });

  it('renders multiple agent_message events joined by newline', () => {
    const events = [
      evt('agent_message', { text: 'Line one.' }),
      evt('agent_message', { text: 'Line two.' }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toBe('Line one.\nLine two.');
  });

  it('skips empty agent_message text', () => {
    const events = [
      evt('agent_message', { text: '' }),
      evt('agent_message', { text: 'Real content' }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toBe('Real content');
  });

  it('renders tool_use as "→ Tool(name): inputPreview"', () => {
    const events = [
      evt('tool_use', { tool: { name: 'Read', inputPreview: 'file_path: src/main.ts' } }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toBe('→ Tool(Read): file_path: src/main.ts');
  });

  it('renders tool_use without inputPreview as "→ Tool(name)"', () => {
    const events = [evt('tool_use', { tool: { name: 'Glob' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('→ Tool(Glob)');
  });

  it('renders file_edit as "→ Edited: path"', () => {
    const events = [evt('file_edit', { file: { path: 'src/foo.ts', tool: 'Edit' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('→ Edited: src/foo.ts');
  });

  it('renders command_run as "→ Ran: command"', () => {
    const events = [evt('command_run', { command: { command: 'npm run test' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('→ Ran: npm run test');
  });

  it('renders question as "→ Tool(AskUserQuestion)"', () => {
    const events = [evt('question', {})];
    const result = renderEventsToContext(events);
    expect(result).toBe('→ Tool(AskUserQuestion)');
  });

  it('renders status as "[supervisor: status]"', () => {
    const events = [evt('status', { status: { status: 'rate_limited', retryAfterMs: 3000 } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('[supervisor: rate_limited]');
  });

  it('renders result (success) as "--- [Result: success] ---"', () => {
    const events = [evt('result', { result: { isError: false } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('--- [Result: success] ---');
  });

  it('renders result (error with subtype) as "--- [Result: error (error_max_turns)] ---"', () => {
    const events = [evt('result', { result: { isError: true, subtype: 'error_max_turns' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('--- [Result: error (error_max_turns)] ---');
  });

  it('renders error kind as "--- [Error: message] ---"', () => {
    const events = [evt('error', { text: 'Something went wrong' })];
    const result = renderEventsToContext(events);
    expect(result).toBe('--- [Error: Something went wrong] ---');
  });
});

// ---------------------------------------------------------------------------
// Suite: task_marker sentinel reconstruction
// ---------------------------------------------------------------------------

describe('renderEventsToContext — task_marker sentinel lines', () => {
  it('renders task_start as "[TASK_START] T001"', () => {
    const events = [evt('task_marker', { marker: { type: 'task_start', taskId: 'T001' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('[TASK_START] T001');
  });

  it('renders task_complete with summary as "[TASK_COMPLETE] T002: implement auth"', () => {
    const events = [
      evt('task_marker', {
        marker: { type: 'task_complete', taskId: 'T002', summary: 'implement auth' },
      }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toBe('[TASK_COMPLETE] T002: implement auth');
  });

  it('renders task_complete without summary as "[TASK_COMPLETE] T003"', () => {
    const events = [evt('task_marker', { marker: { type: 'task_complete', taskId: 'T003' } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('[TASK_COMPLETE] T003');
  });

  it('renders phase_complete as "[PHASE_COMPLETE] Phase 2"', () => {
    const events = [evt('task_marker', { marker: { type: 'phase_complete', phase: 2 } })];
    const result = renderEventsToContext(events);
    expect(result).toBe('[PHASE_COMPLETE] Phase 2');
  });

  it('renders task_marker lines verbatim in a mixed transcript', () => {
    const events = [
      evt('agent_message', { text: 'Starting task.' }),
      evt('task_marker', { marker: { type: 'task_start', taskId: 'T001' } }),
      evt('agent_message', { text: 'Implementing...' }),
      evt('task_marker', { marker: { type: 'task_complete', taskId: 'T001', summary: 'done' } }),
      evt('task_marker', { marker: { type: 'phase_complete', phase: 1 } }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toContain('[TASK_START] T001');
    expect(result).toContain('[TASK_COMPLETE] T001: done');
    expect(result).toContain('[PHASE_COMPLETE] Phase 1');
    // Verify ordering: start before complete
    const startIdx = result.indexOf('[TASK_START] T001');
    const completeIdx = result.indexOf('[TASK_COMPLETE] T001');
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

// ---------------------------------------------------------------------------
// Suite: omitted kinds
// ---------------------------------------------------------------------------

describe('renderEventsToContext — omitted event kinds', () => {
  it('omits thinking events', () => {
    const events = [evt('thinking', { thinkingChars: 500 })];
    expect(renderEventsToContext(events)).toBe('');
  });

  it('omits tool_result events', () => {
    const events = [evt('tool_result', { text: 'file content here...' })];
    expect(renderEventsToContext(events)).toBe('');
  });

  it('omits summary events', () => {
    const events = [evt('summary', { text: 'Implementation complete.' })];
    expect(renderEventsToContext(events)).toBe('');
  });

  it('omits session events', () => {
    const events = [evt('session', { sessionId: 'sess-abc123' })];
    expect(renderEventsToContext(events)).toBe('');
  });

  it('only emits agent_message when mixed with omitted kinds', () => {
    const events = [
      evt('session', { sessionId: 'sess-1' }),
      evt('thinking', { thinkingChars: 100 }),
      evt('agent_message', { text: 'Visible content' }),
      evt('tool_result', { text: 'hidden' }),
      evt('summary', { text: 'hidden summary' }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toBe('Visible content');
  });
});

// ---------------------------------------------------------------------------
// Suite: tail truncation
// ---------------------------------------------------------------------------

describe('renderEventsToContext — tail truncation', () => {
  it('does not truncate when output is within cap', () => {
    const events = [evt('agent_message', { text: 'short text' })];
    const result = renderEventsToContext(events);
    expect(result).not.toContain(TRUNCATION_SENTINEL);
    expect(result).toBe('short text');
  });

  it('prepends TRUNCATION_SENTINEL when output exceeds RENDER_MAX_CHARS', () => {
    // Generate a text that is definitely > 30,000 chars
    const bigText = 'A'.repeat(RENDER_MAX_CHARS + 5000);
    const events = [evt('agent_message', { text: bigText })];
    const result = renderEventsToContext(events);
    expect(result.startsWith(TRUNCATION_SENTINEL)).toBe(true);
    // Output must be <= RENDER_MAX_CHARS + sentinel line length
    // (sentinel + newline adds ~34 chars)
    expect(result.length).toBeLessThanOrEqual(RENDER_MAX_CHARS + TRUNCATION_SENTINEL.length + 5);
  });

  it('keeps the TAIL (most recent content) when truncating', () => {
    // First half is old content, second half is recent content
    const oldPart = 'OLD '.repeat(4000); // ~16k chars
    const recentPart = 'RECENT '.repeat(3000); // ~21k chars
    // Combined (~37k) exceeds the 30k cap
    const events = [
      evt('agent_message', { text: oldPart }),
      evt('agent_message', { text: recentPart }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toContain('RECENT');
    // The very beginning of oldPart is dropped
    expect(result).not.toContain(oldPart.substring(0, 100));
  });

  it('TRUNCATION_SENTINEL is exactly the exported constant', () => {
    expect(TRUNCATION_SENTINEL).toBe('[...earlier output truncated...]');
  });

  it('RENDER_MAX_CHARS is 30000', () => {
    expect(RENDER_MAX_CHARS).toBe(30_000);
  });

  it('preserves task_marker lines after truncation', () => {
    // Build content: big old block + recent markers
    const oldText = 'X'.repeat(RENDER_MAX_CHARS);
    const events = [
      evt('agent_message', { text: oldText }),
      evt('agent_message', { text: '\nFinal message\n' }),
      evt('task_marker', { marker: { type: 'task_complete', taskId: 'T005', summary: 'done' } }),
      evt('result', { result: { isError: false } }),
    ];
    const result = renderEventsToContext(events);
    expect(result).toContain(TRUNCATION_SENTINEL);
    expect(result).toContain('[TASK_COMPLETE] T005: done');
    expect(result).toContain('--- [Result: success] ---');
  });
});

// ---------------------------------------------------------------------------
// Suite: realistic mixed transcript
// ---------------------------------------------------------------------------

describe('renderEventsToContext — realistic mixed transcript', () => {
  it('produces a correctly ordered transcript with all relevant lines', () => {
    const events: NormalizedEvent[] = [
      evt('session', { sessionId: 'sess-xyz' }),
      evt('agent_message', { text: 'Starting implementation.' }),
      evt('thinking', { thinkingChars: 200 }),
      evt('task_marker', { marker: { type: 'task_start', taskId: 'T001' } }),
      evt('tool_use', { tool: { name: 'Read', inputPreview: 'file_path: src/index.ts' } }),
      evt('tool_result', { text: 'file content…' }),
      evt('file_edit', { file: { path: 'src/index.ts', tool: 'Edit' } }),
      evt('command_run', { command: { command: 'npx tsc --noEmit' } }),
      evt('task_marker', {
        marker: { type: 'task_complete', taskId: 'T001', summary: 'added types' },
      }),
      evt('task_marker', { marker: { type: 'phase_complete', phase: 1 } }),
      evt('status', { status: { status: 'resumed' } }),
      evt('summary', { text: 'Implementation done.' }),
      evt('result', { result: { isError: false } }),
    ];

    const result = renderEventsToContext(events);

    // Present
    expect(result).toContain('Starting implementation.');
    expect(result).toContain('[TASK_START] T001');
    expect(result).toContain('→ Tool(Read): file_path: src/index.ts');
    expect(result).toContain('→ Edited: src/index.ts');
    expect(result).toContain('→ Ran: npx tsc --noEmit');
    expect(result).toContain('[TASK_COMPLETE] T001: added types');
    expect(result).toContain('[PHASE_COMPLETE] Phase 1');
    expect(result).toContain('[supervisor: resumed]');
    expect(result).toContain('--- [Result: success] ---');

    // Absent (omitted kinds)
    expect(result).not.toContain('sess-xyz');
    expect(result).not.toContain('file content…');
    expect(result).not.toContain('Implementation done.');

    // Result is last
    const lastLine = result.trimEnd().split('\n').at(-1);
    expect(lastLine).toBe('--- [Result: success] ---');
  });
});
