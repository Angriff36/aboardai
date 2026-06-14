import { describe, it, expect } from 'vitest';
import { NormalizedEventStream } from '../../../src/events/normalizer.js';
import type { ProviderMessage } from '@aboardai/types';

function stream() {
  let n = 0;
  return new NormalizedEventStream({ provider: 'claude', clock: () => `t${n++}` });
}

describe('normalizer enrichment', () => {
  it('emits thinking text (capped) with thinkingChars + thinkingTruncated', () => {
    const s = stream();
    const msg: ProviderMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning here' }] },
    };
    const ev = s.feed(msg).find((e) => e.kind === 'thinking')!;
    expect(ev.text).toBe('reasoning here');
    expect(ev.thinkingChars).toBe('reasoning here'.length);
    expect(ev.thinkingTruncated).toBe(false);
  });

  it('emits a diff on file_edit derived from Edit input', () => {
    const s = stream();
    const msg: ProviderMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            tool_use_id: 'tu1',
            input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    };
    const ev = s.feed(msg).find((e) => e.kind === 'file_edit')!;
    expect(ev.file?.path).toBe('a.ts');
    expect(ev.file?.diff).toEqual({ unified: '- a\n+ b', adds: 1, dels: 1, truncated: false });
  });

  it('marks the file_edit diff truncated when it exceeds DIFF_MAX_CHARS (8000)', () => {
    const s = stream();
    // Single-line old/new strings of 5000 chars each. The Edit hunk is
    // "- " + old (5002) + "\n" + "+ " + new (5002) ≈ 10006 chars > 8000 cap.
    const old_string = 'a'.repeat(5000);
    const new_string = 'b'.repeat(5000);
    const msg: ProviderMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            tool_use_id: 'tu-big',
            input: { file_path: 'big.ts', old_string, new_string },
          },
        ],
      },
    };
    const ev = s.feed(msg).find((e) => e.kind === 'file_edit')!;
    expect(ev.file?.path).toBe('big.ts');
    expect(ev.file?.diff?.truncated).toBe(true);
    // diff-builder truncates via `unified.slice(0, 8000) + '…'`, where '…' is a
    // single code unit, so the bounded length is exactly 8000 + 1 = 8001.
    expect(ev.file?.diff?.unified.length).toBeLessThanOrEqual(8001);
  });

  it('tool_result carries toolUseId correlation on outputs under the 4k cap', () => {
    const s = stream();
    const long = 'y'.repeat(3000);
    const msg: ProviderMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: long }],
      },
    };
    const ev = s.feed(msg).find((e) => e.kind === 'tool_result')!;
    expect(ev.toolUseId).toBe('tu1');
    expect(ev.textTruncated).toBe(false); // 3000 < 4000 cap
    expect(ev.text).toBe(long);
  });
});
