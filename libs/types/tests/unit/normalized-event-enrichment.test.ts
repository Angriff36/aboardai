import { describe, it, expect } from 'vitest';
import type { NormalizedEvent, FileDiff } from '../../src/normalized-event.js';

describe('NormalizedEvent enrichment fields', () => {
  it('accepts a file_edit event carrying a diff', () => {
    const diff: FileDiff = { unified: '- a\n+ b', adds: 1, dels: 1, truncated: false };
    const ev: NormalizedEvent = {
      v: 1,
      id: '0001',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'file_edit',
      provider: 'claude',
      file: { path: 'x.ts', tool: 'Edit', diff },
    };
    expect(ev.file?.diff?.adds).toBe(1);
  });

  it('accepts a thinking event carrying text + truncation flag', () => {
    const ev: NormalizedEvent = {
      v: 1,
      id: '0002',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'thinking',
      provider: 'claude',
      thinkingChars: 5,
      text: 'hello',
      thinkingTruncated: false,
    };
    expect(ev.text).toBe('hello');
  });

  it('accepts a tool_result event with toolUseId + textTruncated', () => {
    const ev: NormalizedEvent = {
      v: 1,
      id: '0003',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'tool_result',
      provider: 'claude',
      text: 'out',
      textTruncated: true,
      toolUseId: 'tu_1',
    };
    expect(ev.toolUseId).toBe('tu_1');
  });
});
