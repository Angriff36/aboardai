import { describe, it, expect } from 'vitest';
import { buildDiff } from '../../../src/events/diff-builder.js';

describe('buildDiff', () => {
  it('Edit: old block removed, new block added', () => {
    const d = buildDiff({ old_string: 'a\nb', new_string: 'a\nc' }, 'Edit');
    expect(d).toEqual({ unified: '- a\n- b\n+ a\n+ c', adds: 2, dels: 2, truncated: false });
  });

  it('Edit with only old_string is a pure deletion', () => {
    const d = buildDiff({ old_string: 'x' }, 'Edit');
    expect(d).toEqual({ unified: '- x', adds: 0, dels: 1, truncated: false });
  });

  it('Write: whole content is all-adds, zero dels', () => {
    const d = buildDiff({ content: 'x\ny' }, 'Write');
    expect(d).toEqual({ unified: '+ x\n+ y', adds: 2, dels: 0, truncated: false });
  });

  it('MultiEdit: concatenates per-edit hunks', () => {
    const d = buildDiff(
      {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      },
      'MultiEdit'
    );
    expect(d?.adds).toBe(2);
    expect(d?.dels).toBe(2);
    expect(d?.unified).toBe('- a\n+ b\n- c\n+ d');
  });

  it('NotebookEdit: new_source is all-adds', () => {
    const d = buildDiff({ new_source: 'cell' }, 'NotebookEdit');
    expect(d).toEqual({ unified: '+ cell', adds: 1, dels: 0, truncated: false });
  });

  it('returns undefined for unrecognized input', () => {
    expect(buildDiff({ nonsense: true }, 'Edit')).toBeUndefined();
    expect(buildDiff(null, 'Edit')).toBeUndefined();
  });

  it('caps oversized diffs and sets truncated', () => {
    const big = 'x'.repeat(9000);
    const d = buildDiff({ content: big }, 'Write');
    expect(d?.truncated).toBe(true);
    expect(d!.unified.length).toBeLessThanOrEqual(8001); // cap + ellipsis
    expect(d?.adds).toBe(1); // counts reflect real content, not the cap
  });
});
