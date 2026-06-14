import { describe, it, expect } from 'vitest';
import type { NormalizedEvent, FileDiff } from '@aboardai/types';

describe('NormalizedEvent enrichment fields', () => {
  it('accepts a file_edit event carrying a diff (survives JSON round-trip)', () => {
    const diff: FileDiff = { unified: '- a\n+ b', adds: 1, dels: 1, truncated: false };
    const event: NormalizedEvent = {
      v: 1,
      id: '0001',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'file_edit',
      provider: 'claude',
      file: { path: 'x.ts', tool: 'Edit', diff },
    };

    const parsed = JSON.parse(JSON.stringify(event)) as NormalizedEvent;
    expect(parsed.kind).toBe('file_edit');
    expect(parsed.file?.path).toBe('x.ts');
    expect(parsed.file?.diff?.unified).toBe('- a\n+ b');
    expect(parsed.file?.diff?.adds).toBe(1);
    expect(parsed.file?.diff?.dels).toBe(1);
    expect(parsed.file?.diff?.truncated).toBe(false);
  });

  it('accepts a thinking event carrying text + truncation flag (survives JSON round-trip)', () => {
    const event: NormalizedEvent = {
      v: 1,
      id: '0002',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'thinking',
      provider: 'claude',
      thinkingChars: 5,
      text: 'hello',
      thinkingTruncated: false,
    };

    const parsed = JSON.parse(JSON.stringify(event)) as NormalizedEvent;
    expect(parsed.kind).toBe('thinking');
    expect(parsed.text).toBe('hello');
    expect(parsed.thinkingChars).toBe(5);
    expect(parsed.thinkingTruncated).toBe(false);
  });

  it('accepts a tool_result event with toolUseId + textTruncated (survives JSON round-trip)', () => {
    const event: NormalizedEvent = {
      v: 1,
      id: '0003',
      ts: '2026-06-14T00:00:00.000Z',
      kind: 'tool_result',
      provider: 'claude',
      text: 'out',
      textTruncated: true,
      toolUseId: 'tu_1',
    };

    const parsed = JSON.parse(JSON.stringify(event)) as NormalizedEvent;
    expect(parsed.kind).toBe('tool_result');
    expect(parsed.text).toBe('out');
    expect(parsed.textTruncated).toBe(true);
    expect(parsed.toolUseId).toBe('tu_1');
  });
});
