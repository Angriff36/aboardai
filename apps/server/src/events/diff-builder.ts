import type { FileDiff } from '@aboardai/types';

const DIFF_MAX_CHARS = 8000;

function lines(s: string): string[] {
  return s.length === 0 ? [] : s.split('\n');
}

function buildHunk(oldS: string | undefined, newS: string | undefined): string {
  const del = typeof oldS === 'string' ? lines(oldS).map((l) => `- ${l}`) : [];
  const add = typeof newS === 'string' ? lines(newS).map((l) => `+ ${l}`) : [];
  return [...del, ...add].join('\n');
}

/** Build a replacement-hunk diff (old lines '- ', new lines '+ ') from an edit tool input. */
export function buildDiff(input: unknown, toolName: string): FileDiff | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  let unified: string;
  let adds = 0;
  let dels = 0;

  if (toolName === 'Write') {
    if (typeof obj['content'] !== 'string') return undefined;
    const ls = lines(obj['content']);
    adds = ls.length;
    unified = ls.map((l) => `+ ${l}`).join('\n');
  } else if (toolName === 'NotebookEdit') {
    const src = obj['new_source'];
    if (typeof src !== 'string') return undefined;
    const ls = lines(src);
    adds = ls.length;
    unified = ls.map((l) => `+ ${l}`).join('\n');
  } else if (toolName === 'MultiEdit') {
    const edits = obj['edits'];
    if (!Array.isArray(edits)) return undefined;
    const hunks: string[] = [];
    for (const e of edits) {
      if (e && typeof e === 'object') {
        const eo = e as Record<string, unknown>;
        const oldS = typeof eo['old_string'] === 'string' ? eo['old_string'] : undefined;
        const newS = typeof eo['new_string'] === 'string' ? eo['new_string'] : undefined;
        if (oldS !== undefined) dels += lines(oldS).length;
        if (newS !== undefined) adds += lines(newS).length;
        const hunk = buildHunk(oldS, newS);
        if (hunk) hunks.push(hunk);
      }
    }
    if (hunks.length === 0) return undefined;
    unified = hunks.join('\n');
  } else {
    // Edit (default)
    if (typeof obj['old_string'] !== 'string' && typeof obj['new_string'] !== 'string') {
      return undefined;
    }
    const oldS = typeof obj['old_string'] === 'string' ? obj['old_string'] : undefined;
    const newS = typeof obj['new_string'] === 'string' ? obj['new_string'] : undefined;
    if (oldS !== undefined) dels += lines(oldS).length;
    if (newS !== undefined) adds += lines(newS).length;
    unified = buildHunk(oldS, newS);
  }

  if (!unified) return undefined;

  let truncated = false;
  if (unified.length > DIFF_MAX_CHARS) {
    unified = unified.slice(0, DIFF_MAX_CHARS) + '…';
    truncated = true;
  }
  return { unified, adds, dels, truncated };
}
