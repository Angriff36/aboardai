/**
 * NormalizedEventStream — unit tests
 *
 * Fixture-driven runner: loads each *.json in ./fixtures/ and verifies
 * that feed() + finalize() produce the expected NormalizedEvents.
 *
 * Additional named tests cover:
 *  - chunk-boundary marker reassembly
 *  - marker dedup on overlapping re-sends
 *  - finalize() summary extraction
 *  - monotonic id generation
 *  - derived-event pairing order (generic tool_use BEFORE derived)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { NormalizedEventStream } from '../../../src/events/normalizer.js';
import type { NormalizedEvent } from '@aboardai/types';
import type { ProviderMessage } from '@aboardai/types';

// ---------------------------------------------------------------------------
// Fixture runner helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  description: string;
  input: ProviderMessage[];
  expected: Partial<NormalizedEvent>[];
  /** Events expected ONLY from finalize() (optional, used by phase-marker-and-summary) */
  expectedFromFinalize?: Partial<NormalizedEvent>[];
}

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Fixture-to-provider mapping — each fixture is authored for a specific provider */
const FIXTURE_PROVIDER_MAP: Record<string, string> = {
  'claude-basic': 'claude',
  'claude-file-and-command': 'claude',
  'claude-thinking': 'claude',
  'markers-split-chunks': 'claude',
  'phase-marker-and-summary': 'claude',
  'supervisor-passthrough': 'claude',
  'error-result': 'claude',
  'codex-mapped': 'codex',
  'cursor-mapped': 'cursor',
};

/** Feature IDs matching the fixtures */
const FIXTURE_FEATURE_MAP: Record<string, string> = {
  'claude-basic': 'feat-001',
  'claude-file-and-command': 'feat-002',
  'claude-thinking': 'feat-003',
  'markers-split-chunks': 'feat-004',
  'phase-marker-and-summary': 'feat-005',
  'supervisor-passthrough': 'feat-006',
  'error-result': 'feat-007',
  'codex-mapped': 'feat-008',
  'cursor-mapped': 'feat-009',
};

/** Fixed clock for deterministic timestamps in tests */
const fixedClock = () => '2026-01-01T00:00:00.000Z';

/** Compare actual event against expected, ignoring ts and treating id as monotonic placeholder */
function assertEventMatches(
  actual: NormalizedEvent,
  expected: Partial<NormalizedEvent>,
  idx: number
): void {
  // v is always 1
  expect(actual.v, `event[${idx}].v`).toBe(1);

  // id sentinel: "__monotonic__" means "just check it's a non-empty string"
  if (expected.id === '__monotonic__') {
    expect(typeof actual.id, `event[${idx}].id should be string`).toBe('string');
    expect(actual.id.length, `event[${idx}].id should be non-empty`).toBeGreaterThan(0);
  } else if (expected.id !== undefined) {
    expect(actual.id, `event[${idx}].id`).toBe(expected.id);
  }

  // ts sentinel: "__any__" means "just check it's a non-empty string"
  if (expected.ts === '__any__') {
    expect(typeof actual.ts, `event[${idx}].ts should be string`).toBe('string');
  } else if (expected.ts !== undefined) {
    expect(actual.ts, `event[${idx}].ts`).toBe(expected.ts);
  }

  // Check all other fields.
  // Object-typed values use objectContaining so fixtures can omit optional fields
  // (e.g. `tool` doesn't need to specify `inputPreview`).
  const skipFields = new Set(['id', 'ts']);
  for (const [key, val] of Object.entries(expected)) {
    if (skipFields.has(key)) continue;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      expect((actual as Record<string, unknown>)[key], `event[${idx}].${key}`).toMatchObject(
        val as Record<string, unknown>
      );
    } else {
      expect((actual as Record<string, unknown>)[key], `event[${idx}].${key}`).toEqual(val);
    }
  }
}

/** Run all messages through the stream and optionally call finalize() */
function runFixture(
  fixture: FixtureFile,
  provider: string,
  featureId: string
): { feedEvents: NormalizedEvent[]; finalizeEvents: NormalizedEvent[] } {
  const stream = new NormalizedEventStream({ provider, featureId, clock: fixedClock });
  const feedEvents: NormalizedEvent[] = [];
  for (const msg of fixture.input) {
    feedEvents.push(...stream.feed(msg));
  }
  const finalizeEvents = stream.finalize();
  return { feedEvents, finalizeEvents };
}

// ---------------------------------------------------------------------------
// Fixture-driven test suite
// ---------------------------------------------------------------------------

describe('NormalizedEventStream — fixture-driven', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
  expect(fixtureFiles.length).toBeGreaterThanOrEqual(9); // sanity

  for (const filename of fixtureFiles) {
    const fixtureName = filename.replace('.json', '');
    const fixture: FixtureFile = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8')
    );
    const provider = FIXTURE_PROVIDER_MAP[fixtureName] ?? 'claude';
    const featureId = FIXTURE_FEATURE_MAP[fixtureName] ?? 'feat-xxx';

    it(`fixture: ${fixtureName}`, () => {
      const { feedEvents, finalizeEvents } = runFixture(fixture, provider, featureId);

      // Compare feed() output
      expect(feedEvents.length, `${fixtureName}: event count from feed()`).toBe(
        fixture.expected.length
      );
      for (let i = 0; i < fixture.expected.length; i++) {
        assertEventMatches(feedEvents[i], fixture.expected[i], i);
      }

      // Compare finalize() output if the fixture has expectedFromFinalize
      if (fixture.expectedFromFinalize !== undefined) {
        expect(finalizeEvents.length, `${fixtureName}: event count from finalize()`).toBe(
          fixture.expectedFromFinalize.length
        );
        for (let i = 0; i < fixture.expectedFromFinalize.length; i++) {
          assertEventMatches(finalizeEvents[i], fixture.expectedFromFinalize[i], i);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Named tests for critical behaviors
// ---------------------------------------------------------------------------

describe('NormalizedEventStream — chunk-boundary marker reassembly', () => {
  it('reassembles [TASK_START] split across two text chunks', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    // Chunk 1: partial marker
    const evts1 = stream.feed({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Work begins. [TASK_ST' }] },
    });
    // No task_marker yet — marker not complete
    expect(evts1.some((e) => e.kind === 'task_marker')).toBe(false);

    // Chunk 2: completes the marker
    const evts2 = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ART] T042\nDoing stuff.\n' }],
      },
    });
    const markerEvts = evts2.filter((e) => e.kind === 'task_marker');
    expect(markerEvts).toHaveLength(1);
    expect(markerEvts[0].marker?.type).toBe('task_start');
    expect(markerEvts[0].marker?.taskId).toBe('T042');
  });

  it('emits task_complete with summary when marker is fully received', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '[TASK_COMPLETE] T007: fixed the bug\n' }],
      },
    });

    const marker = evts.find((e) => e.kind === 'task_marker');
    expect(marker?.marker?.type).toBe('task_complete');
    expect(marker?.marker?.taskId).toBe('T007');
    expect(marker?.marker?.summary).toBe('fixed the bug');
  });
});

describe('NormalizedEventStream — marker dedup', () => {
  it('does NOT duplicate task_start when the same taskId appears in subsequent accumulated text', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    // First chunk triggers the marker
    const evts1 = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '[TASK_START] T001\n' }],
      },
    });
    expect(evts1.filter((e) => e.kind === 'task_marker')).toHaveLength(1);

    // Subsequent chunk that would re-trigger if not for the dedup set
    const evts2 = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'More work. [TASK_START] T001\n' }],
      },
    });
    // Should NOT fire again
    expect(evts2.filter((e) => e.kind === 'task_marker')).toHaveLength(0);
  });

  it('fires each unique taskId exactly once even when both start and complete appear', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts1 = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '[TASK_START] T002\ndoing work\n[TASK_COMPLETE] T002: done\n' },
        ],
      },
    });

    const markers = evts1.filter((e) => e.kind === 'task_marker');
    expect(markers).toHaveLength(2);
    expect(markers[0].marker?.type).toBe('task_start');
    expect(markers[0].marker?.taskId).toBe('T002');
    expect(markers[1].marker?.type).toBe('task_complete');
    expect(markers[1].marker?.taskId).toBe('T002');

    // Re-feeding overlapping text yields no new markers
    const evts2 = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '[TASK_START] T002\n[TASK_COMPLETE] T002: done\n' }],
      },
    });
    expect(evts2.filter((e) => e.kind === 'task_marker')).toHaveLength(0);
  });
});

describe('NormalizedEventStream — finalize() summary extraction', () => {
  it('returns a summary event when <summary> tag is in accumulated text', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Work done.\n<summary>Implemented the feature.</summary>' },
        ],
      },
    });

    const finalEvents = stream.finalize();
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].kind).toBe('summary');
    expect(finalEvents[0].text).toBe('Implemented the feature.');
  });

  it('returns empty array when no summary is found', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Just some text without a summary.' }],
      },
    });

    expect(stream.finalize()).toHaveLength(0);
  });

  it('extracts ## Summary section via finalize()', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '## Summary\n\nFixed the authentication bug.\n' }],
      },
    });

    const finalEvents = stream.finalize();
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].kind).toBe('summary');
    expect(finalEvents[0].text).toContain('Fixed the authentication bug');
  });
});

describe('NormalizedEventStream — monotonic ids', () => {
  it('ids are monotonically increasing as zero-padded strings', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts: NormalizedEvent[] = [];
    evts.push(
      ...stream.feed({
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      })
    );
    evts.push(
      ...stream.feed({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      })
    );

    // All ids should be numeric-string parseable and strictly increasing
    const nums = evts.map((e) => parseInt(e.id, 10));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i], `id[${i}] > id[${i - 1}]`).toBeGreaterThan(nums[i - 1]);
    }
  });

  it('ids from separate instances are independent (each starts at 1)', () => {
    const s1 = new NormalizedEventStream({ provider: 'claude', clock: fixedClock });
    const s2 = new NormalizedEventStream({ provider: 'claude', clock: fixedClock });

    const e1 = s1.feed({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    });
    const e2 = s2.feed({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    });

    expect(e1[0].id).toBe('0001');
    expect(e2[0].id).toBe('0001');
  });
});

describe('NormalizedEventStream — derived-event pairing order', () => {
  it('emits generic tool_use BEFORE derived file_edit for Edit tool', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            tool_use_id: 'tu-1',
            input: { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' },
          },
        ],
      },
    });

    expect(evts[0].kind).toBe('tool_use');
    expect(evts[1].kind).toBe('file_edit');
  });

  it('emits generic tool_use BEFORE derived command_run for Bash tool', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            tool_use_id: 'tu-2',
            input: { command: 'echo hello' },
          },
        ],
      },
    });

    expect(evts[0].kind).toBe('tool_use');
    expect(evts[1].kind).toBe('command_run');
    expect(evts[1].command?.command).toBe('echo hello');
  });

  it('emits generic tool_use BEFORE derived question for AskUserQuestion tool', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            tool_use_id: 'tu-3',
            input: { question: 'What should I do?' },
          },
        ],
      },
    });

    expect(evts[0].kind).toBe('tool_use');
    expect(evts[1].kind).toBe('question');
  });

  it('emits tool_use + file_edit for Write/MultiEdit/NotebookEdit tools', () => {
    for (const toolName of ['Write', 'MultiEdit', 'NotebookEdit']) {
      const stream = new NormalizedEventStream({
        provider: 'claude',
        featureId: 'test',
        clock: fixedClock,
      });

      const evts = stream.feed({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: toolName,
              tool_use_id: 'tu-x',
              input: { file_path: '/src/b.ts' },
            },
          ],
        },
      });

      expect(evts[0].kind, `${toolName}: first event kind`).toBe('tool_use');
      expect(evts[1].kind, `${toolName}: second event kind`).toBe('file_edit');
      expect(evts[1].file?.tool, `${toolName}: file.tool`).toBe(toolName);
    }
  });
});

describe('NormalizedEventStream — thinking', () => {
  it('emits thinkingChars, text, and thinkingTruncated for thinking blocks', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const thinking = 'This is my internal reasoning chain.';
    const evts = stream.feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking }],
      },
    });

    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('thinking');
    expect(evts[0].thinkingChars).toBe(thinking.length);
    // text is now emitted (enriched behavior)
    expect(evts[0].text).toBe(thinking);
    expect(evts[0].thinkingTruncated).toBe(false);
  });
});

describe('NormalizedEventStream — tool_result truncation', () => {
  it('truncates tool_result content at 4000 chars', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const longContent = 'x'.repeat(4500);
    const evts = stream.feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: longContent }],
      },
    });

    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('tool_result');
    expect(evts[0].text!.length).toBeLessThanOrEqual(4001); // 4000 + ellipsis char
    expect(evts[0].textTruncated).toBe(true);
    expect(evts[0].toolUseId).toBe('tu-1');
  });

  it('does not truncate short tool_result content', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'short result' }],
      },
    });

    expect(evts[0].text).toBe('short result');
  });

  it('flattens array-shaped tool_result content into a string (Anthropic block form)', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    // Anthropic tool_result content can be an array of content blocks, not just a string.
    // Passing the array straight through makes event.text an object → React error #31.
    const evts = stream.feed({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [
              { type: 'text', text: 'first line' },
              { type: 'text', text: 'second line' },
            ],
          },
        ],
      },
    });

    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('tool_result');
    expect(typeof evts[0].text).toBe('string');
    expect(evts[0].text).toBe('first line\nsecond line');
  });

  it('renders non-text blocks in array tool_result content without leaking objects', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }],
          },
        ],
      },
    });

    expect(typeof evts[0].text).toBe('string');
    // Must not contain a literal "[object Object]" leak.
    expect(evts[0].text).not.toContain('[object Object]');
  });
});

describe('NormalizedEventStream — session event', () => {
  it('emits session event on first session_id observed', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({
      type: 'assistant',
      session_id: 'sess-xyz',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });

    expect(evts[0].kind).toBe('session');
    expect(evts[0].sessionId).toBe('sess-xyz');
  });

  it('emits a new session event when session_id changes', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    stream.feed({
      type: 'assistant',
      session_id: 'sess-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    });

    const evts2 = stream.feed({
      type: 'assistant',
      session_id: 'sess-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    });

    const sessionEvts = evts2.filter((e) => e.kind === 'session');
    expect(sessionEvts).toHaveLength(1);
    expect(sessionEvts[0].sessionId).toBe('sess-2');
  });

  it('does NOT emit duplicate session event for same session_id', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    stream.feed({
      type: 'assistant',
      session_id: 'sess-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    });

    const evts2 = stream.feed({
      type: 'assistant',
      session_id: 'sess-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    });

    expect(evts2.filter((e) => e.kind === 'session')).toHaveLength(0);
  });
});

describe('NormalizedEventStream — error and result', () => {
  it('emits error event for type:error messages', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({ type: 'error', error: 'something went wrong' });
    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('error');
    expect(evts[0].text).toBe('something went wrong');
  });

  it('emits result{isError:true} for error subtypes', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({ type: 'result', subtype: 'error_during_execution' });
    expect(evts).toHaveLength(1);
    expect(evts[0].kind).toBe('result');
    expect(evts[0].result?.isError).toBe(true);
    expect(evts[0].result?.subtype).toBe('error_during_execution');
  });

  it('emits result{isError:false} for success subtype', () => {
    const stream = new NormalizedEventStream({
      provider: 'claude',
      featureId: 'test',
      clock: fixedClock,
    });

    const evts = stream.feed({ type: 'result', subtype: 'success' });
    expect(evts).toHaveLength(1);
    expect(evts[0].result?.isError).toBe(false);
  });
});
