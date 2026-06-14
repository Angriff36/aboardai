# Agent Trajectory View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat agent-activity log with a structured, phase-grouped "trajectory" view that renders one card per action (commands, file edits with inline diffs, thinking, results), for both live and completed runs.

**Architecture:** Unify on the Phase-3 `NormalizedEvent` pipeline (already persisted to `events.jsonl` and broadcast over WS as `feature:event`, but never consumed by the UI). Enrich events at the normalizer to carry diffs / thinking text / fuller output (the data is already in hand, just discarded), add a replay endpoint, consume both live + replay in a new Zustand slice, and render with per-kind card components mounted as the new default tab in the agent-output modal.

**Tech Stack:** TypeScript, Express 5 (server), Vitest (unit), React 19 + Zustand 5 + Tailwind 4 (UI), Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-06-14-agent-trajectory-view-design.md`

**Conventions / gotchas:**

- Run unit tests with `npx vitest run <path>` from repo root. Run E2E with `npm run test -- --workers=2` (NEVER default workers on this machine).
- `npm run build:packages` after changing `libs/types` (downstream packages consume the built output).
- Any **new** UI npm dependency must be added to `optimizeDeps.include` in `apps/ui/vite.config.mts` (guard test enforces this). This plan adds **no** new UI dependency (diff rendering is hand-rolled).
- Event `id` resets per provider-call (`0001`…) and a feature run spawns multiple streams, so `id` is NOT unique within a feature — dedupe on the composite key `` `${id}:${ts}` ``.
- New UI state goes in a **new store slice**, never in `app-store.ts` (monolith rule).
- Commit after each task with `[type] message` format.

---

## Task 1: Extend NormalizedEvent type (additive)

**Files:**

- Modify: `libs/types/src/normalized-event.ts`
- Test: `libs/types/tests/unit/normalized-event-enrichment.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `libs/types/tests/unit/normalized-event-enrichment.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/types/tests/unit/normalized-event-enrichment.test.ts`
Expected: FAIL — `FileDiff` not exported / properties `diff`, `thinkingTruncated`, `textTruncated`, `toolUseId` do not exist on the types.

- [ ] **Step 3: Add the types**

In `libs/types/src/normalized-event.ts`, add the `FileDiff` interface above `NormalizedEvent` and extend the interface. Replace the `file?` line and add the new optional fields:

```ts
/** A simple replacement-hunk diff for a single edit (old lines removed, new lines added). */
export interface FileDiff {
  unified: string; // hunk text: removed lines prefixed '- ', added lines prefixed '+ '
  adds: number;
  dels: number;
  truncated: boolean; // true if `unified` was capped
}
```

Inside `NormalizedEvent`, change:

```ts
  file?: { path: string; tool: string };
```

to:

```ts
  file?: { path: string; tool: string; diff?: FileDiff };
```

and add these optional fields (anywhere in the payload block, e.g. after `thinkingChars`):

```ts
  toolUseId?: string; // tool_result: id of the tool_use this result belongs to (correlation)
  thinkingTruncated?: boolean; // thinking: true if `text` was capped
  textTruncated?: boolean; // tool_result: true if `text` was capped
```

(Note: `text` is reused to carry full thinking content for `thinking` events and fuller output for `tool_result` events.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/types/tests/unit/normalized-event-enrichment.test.ts`
Expected: PASS

- [ ] **Step 5: Rebuild types package**

Run: `npm run build:packages`
Expected: all libs compile clean.

- [ ] **Step 6: Commit**

```bash
git add libs/types/src/normalized-event.ts libs/types/tests/unit/normalized-event-enrichment.test.ts
git commit -m "[feat] extend NormalizedEvent with diff/thinking-text/output-correlation fields"
```

---

## Task 2: Diff builder (pure helper)

**Files:**

- Create: `apps/server/src/events/diff-builder.ts`
- Test: `apps/server/tests/unit/events/diff-builder.test.ts` (create)

Approach: a single Edit replaces an old block with a new block. We render a "replacement hunk" — old lines as `- `, new lines as `+ ` — rather than a minimal LCS diff. Deterministic, dependency-free, and readable. Write = all-adds; MultiEdit = concatenated per-edit hunks; NotebookEdit = best-effort (`new_source` as adds).

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/unit/events/diff-builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildDiff } from '../../../src/events/diff-builder.js';

describe('buildDiff', () => {
  it('Edit: old block removed, new block added', () => {
    const d = buildDiff({ old_string: 'a\nb', new_string: 'a\nc' }, 'Edit');
    expect(d).toEqual({ unified: '- a\n- b\n+ a\n+ c', adds: 2, dels: 2, truncated: false });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/tests/unit/events/diff-builder.test.ts`
Expected: FAIL — module `diff-builder` not found.

- [ ] **Step 3: Implement the diff builder**

Create `apps/server/src/events/diff-builder.ts`:

```ts
import type { FileDiff } from '@aboardai/types';

const DIFF_MAX_CHARS = 8000;

function lines(s: string): string[] {
  return s.length === 0 ? [] : s.split('\n');
}

/** Build a replacement-hunk diff (old lines '- ', new lines '+ ') from an edit tool input. */
export function buildDiff(input: unknown, toolName: string): FileDiff | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  const del: string[] = [];
  const add: string[] = [];

  const pushPair = (oldS: unknown, newS: unknown): void => {
    if (typeof oldS === 'string') del.push(...lines(oldS));
    if (typeof newS === 'string') add.push(...lines(newS));
  };

  if (toolName === 'Write') {
    if (typeof obj['content'] !== 'string') return undefined;
    add.push(...lines(obj['content']));
  } else if (toolName === 'NotebookEdit') {
    const src = obj['new_source'];
    if (typeof src !== 'string') return undefined;
    add.push(...lines(src));
  } else if (toolName === 'MultiEdit') {
    const edits = obj['edits'];
    if (!Array.isArray(edits)) return undefined;
    for (const e of edits) {
      if (e && typeof e === 'object') {
        const eo = e as Record<string, unknown>;
        pushPair(eo['old_string'], eo['new_string']);
      }
    }
  } else {
    // Edit (default)
    if (typeof obj['old_string'] !== 'string' && typeof obj['new_string'] !== 'string') {
      return undefined;
    }
    pushPair(obj['old_string'], obj['new_string']);
  }

  if (del.length === 0 && add.length === 0) return undefined;

  const adds = add.length;
  const dels = del.length;
  let unified = [...del.map((l) => `- ${l}`), ...add.map((l) => `+ ${l}`)].join('\n');
  let truncated = false;
  if (unified.length > DIFF_MAX_CHARS) {
    unified = unified.slice(0, DIFF_MAX_CHARS) + '…';
    truncated = true;
  }
  return { unified, adds, dels, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/tests/unit/events/diff-builder.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/events/diff-builder.ts apps/server/tests/unit/events/diff-builder.test.ts
git commit -m "[feat] add buildDiff replacement-hunk helper for edit tools"
```

---

## Task 3: Enrich the normalizer

**Files:**

- Modify: `apps/server/src/events/normalizer.ts`
- Test: `apps/server/tests/unit/events/normalizer-enrichment.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/unit/events/normalizer-enrichment.test.ts`:

```ts
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

  it('tool_result carries toolUseId and fuller (4k) output', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/tests/unit/events/normalizer-enrichment.test.ts`
Expected: FAIL — thinking has no `text`; file_edit has no `diff`; tool_result has no `toolUseId`, and 3000-char content is truncated at 500.

- [ ] **Step 3: Apply the enrichment edits**

In `apps/server/src/events/normalizer.ts`:

(a) Add the import near the top (after the existing type imports):

```ts
import { buildDiff } from './diff-builder.js';
```

(b) Raise the cap constant:

```ts
const TOOL_RESULT_MAX_CHARS = 4000;
```

(c) Add a private helper for tool_result events (place it among the other private helpers, e.g. above `previewInput`):

```ts
  private toolResultEvent(raw: string, toolUseId?: string): NormalizedEvent {
    const truncated = raw.length > TOOL_RESULT_MAX_CHARS;
    const text = truncated ? raw.substring(0, TOOL_RESULT_MAX_CHARS) + '…' : raw;
    return this.make('tool_result', { text, textTruncated: truncated, toolUseId });
  }
```

(d) Replace the `processUser` tool_result branch body (currently builds `truncated` inline) with:

```ts
if (block.type === 'tool_result') {
  events.push(this.toolResultEvent(block.content ?? '', block.tool_use_id));
}
```

(e) Replace the `thinking` case in `processBlock`:

```ts
      case 'thinking': {
        const full = block.thinking ?? '';
        const truncated = full.length > THINKING_MAX_CHARS;
        const text = truncated ? full.substring(0, THINKING_MAX_CHARS) + '…' : full;
        events.push(
          this.make('thinking', { thinkingChars: full.length, text, thinkingTruncated: truncated })
        );
        break;
      }
```

and add the cap constant near `TOOL_RESULT_MAX_CHARS`:

```ts
const THINKING_MAX_CHARS = 4000;
```

(f) In the `tool_use` case, where `file_edit` is derived, add the diff:

```ts
if (FILE_EDIT_TOOLS.has(name)) {
  const filePath = this.extractFilePath(block.input);
  if (filePath) {
    const diff = buildDiff(block.input, name);
    events.push(this.make('file_edit', { file: { path: filePath, tool: name, diff } }));
  }
}
```

(g) Replace the `processBlock` `tool_result` case body to use the helper:

```ts
      case 'tool_result': {
        events.push(this.toolResultEvent(block.content ?? '', block.tool_use_id));
        break;
      }
```

- [ ] **Step 4: Run the new test + the existing normalizer tests**

Run: `npx vitest run apps/server/tests/unit/events/`
Expected: the new enrichment test PASSES. **Existing tests may fail** if they asserted the old 500-char truncation or the thinking-has-no-text behavior — update those assertions to match the new caps (4000) and the presence of `text`/`toolUseId`. Re-run until green.

- [ ] **Step 5: Update golden fixtures if present**

Run: `npx vitest run libs/types/tests/unit/normalized-event.test.ts apps/server/tests`
If any golden-fixture test fails purely due to additive fields, update the expected fixtures to include the new optional fields. Confirm old persisted-event parsing still passes (additive = backward compatible).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/events/normalizer.ts apps/server/tests/unit/events/normalizer-enrichment.test.ts
git commit -m "[feat] enrich normalizer: thinking text, edit diffs, tool_result correlation + 4k output"
```

---

## Task 4: Replay endpoint (POST /api/features/events)

**Files:**

- Create: `apps/server/src/routes/features/routes/events.ts`
- Modify: `apps/server/src/routes/features/index.ts`
- Test: `apps/server/tests/unit/routes/features-events.test.ts` (create)

Convention note: feature routes are POST + JSON body `{ projectPath, featureId }` (verified: `routes/features/routes/get.ts`). We mirror that.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/unit/routes/features-events.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/events/event-log.js', () => ({
  readEventLog: vi.fn(async () => [
    { v: 1, id: '0001', ts: 't', kind: 'agent_message', provider: 'claude', text: 'hi' },
  ]),
}));

import { createEventsHandler } from '../../../src/routes/features/routes/events.js';

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe('POST /api/features/events handler', () => {
  it('400 when projectPath/featureId missing', async () => {
    const res = mockRes();
    await createEventsHandler()({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('returns events from readEventLog', async () => {
    const res = mockRes();
    await createEventsHandler()(
      { body: { projectPath: '/p', featureId: 'f1' } } as never,
      res as never
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean; events: unknown[] }).events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/tests/unit/routes/features-events.test.ts`
Expected: FAIL — module `events.js` not found.

- [ ] **Step 3: Implement the handler**

Create `apps/server/src/routes/features/routes/events.ts`:

```ts
import type { Request, Response } from 'express';
import { readEventLog } from '../../../events/event-log.js';
import { getErrorMessage, logError } from '../common.js';

export function createEventsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as { projectPath: string; featureId: string };
      if (!projectPath || !featureId) {
        res.status(400).json({ success: false, error: 'projectPath and featureId are required' });
        return;
      }
      const events = await readEventLog(projectPath, featureId);
      res.json({ success: true, events });
    } catch (error) {
      logError(error, 'Get feature events failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
```

- [ ] **Step 4: Register the route**

In `apps/server/src/routes/features/index.ts`: import the handler at the top alongside the other route imports:

```ts
import { createEventsHandler } from './routes/events.js';
```

and register it next to the existing `POST /get` registration (mirror that line, including the same `validatePathParams('projectPath')` middleware the sibling POST routes use):

```ts
router.post('/events', validatePathParams('projectPath'), createEventsHandler());
```

(If `validatePathParams` is not already imported in this file, copy the import used by the sibling routes. If the existing routes do not use that middleware on `/get`, omit it here to match.)

- [ ] **Step 5: Run handler test + build**

Run: `npx vitest run apps/server/tests/unit/routes/features-events.test.ts`
Expected: PASS.
Run: `npm run build:server`
Expected: compiles clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/features/routes/events.ts apps/server/src/routes/features/index.ts apps/server/tests/unit/routes/features-events.test.ts
git commit -m "[feat] add POST /api/features/events replay endpoint (reads events.jsonl)"
```

---

## Task 5: Client — event type, subscription helper, getEvents

**Files:**

- Modify: `apps/ui/src/lib/http-api-client.ts`

- [ ] **Step 1: Add `feature:event` to the EventType union**

Find the `EventType` union (~line 592-612) and add a member:

```ts
  | 'feature:event'
```

- [ ] **Step 2: Add a `NormalizedEvent` type import**

Ensure the file imports the type (add to an existing `@aboardai/types` import or a new one near the top):

```ts
import type { NormalizedEvent } from '@aboardai/types';
```

- [ ] **Step 3: Add `getEvents` + `onFeatureEvent` to the `features` API object**

Find the public `features` API object in this file (where `features.get` / `features.list` etc. live) and add these two members (mirroring `groups.onGroupEvent` at ~line 2275 and the `this.post` pattern at ~line 1030):

```ts
    getEvents: (projectPath: string, featureId: string) =>
      this.post<{ success: boolean; events?: NormalizedEvent[]; error?: string }>(
        '/api/features/events',
        { projectPath, featureId }
      ),

    onFeatureEvent: (
      callback: (payload: { featureId: string; projectPath: string; event: NormalizedEvent }) => void
    ): (() => void) => {
      return this.subscribeToEvent('feature:event', callback as EventCallback);
    },
```

(If `features` is not a single object literal, add `getEvents`/`onFeatureEvent` wherever the other `features.*` methods are defined, matching their style.)

- [ ] **Step 4: Typecheck**

Run: `npm run build` (or `npx tsc -p apps/ui` if faster)
Expected: compiles clean. (No runtime test here; covered by Task 6 store tests and Task 9 E2E.)

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/http-api-client.ts
git commit -m "[feat] client: feature:event subscription + features.getEvents replay call"
```

---

## Task 6: Trajectory store + phase grouping

**Files:**

- Create: `apps/ui/src/lib/trajectory-grouping.ts`
- Create: `apps/ui/src/store/trajectory-store.ts`
- Test: `apps/ui/tests/unit/lib/trajectory-grouping.test.ts` (create)
- Test: `apps/ui/tests/unit/store/trajectory-store.test.ts` (create)

### 6A — Grouping helper

- [ ] **Step 1: Write the failing test**

Create `apps/ui/tests/unit/lib/trajectory-grouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupTrajectory } from '../../../src/lib/trajectory-grouping';
import type { NormalizedEvent } from '@aboardai/types';

const ev = (
  id: string,
  kind: NormalizedEvent['kind'],
  extra: Partial<NormalizedEvent> = {}
): NormalizedEvent => ({ v: 1, id, ts: id, kind, provider: 'claude', ...extra });

describe('groupTrajectory', () => {
  it('puts pre-marker events in an Activity group', () => {
    const groups = groupTrajectory([
      ev('1', 'agent_message', { text: 'hi' }),
      ev('2', 'command_run', { command: { command: 'ls' } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Activity');
    expect(groups[0].events).toHaveLength(2);
  });

  it('starts a new group on task_start and marks done on task_complete', () => {
    const groups = groupTrajectory([
      ev('1', 'task_marker', { marker: { type: 'task_start', taskId: 'T001' } }),
      ev('2', 'command_run', { command: { command: 'npm test' } }),
      ev('3', 'task_marker', {
        marker: { type: 'task_complete', taskId: 'T001', summary: 'done' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('T001');
    expect(groups[0].done).toBe(true);
    expect(groups[0].summary).toBe('done');
    expect(groups[0].events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/ui/tests/unit/lib/trajectory-grouping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the grouping helper**

Create `apps/ui/src/lib/trajectory-grouping.ts`:

```ts
import type { NormalizedEvent } from '@aboardai/types';

export interface TrajectoryGroup {
  key: string;
  title: string;
  done: boolean;
  summary?: string;
  events: NormalizedEvent[];
}

/** Group a flat event list into phase/task groups by task_marker boundaries. */
export function groupTrajectory(events: NormalizedEvent[]): TrajectoryGroup[] {
  const groups: TrajectoryGroup[] = [];
  let current: TrajectoryGroup = { key: 'activity', title: 'Activity', done: false, events: [] };

  const flush = () => {
    if (current.events.length > 0 || current.done) groups.push(current);
  };

  for (const e of events) {
    if (e.kind === 'task_marker' && e.marker) {
      if (e.marker.type === 'task_start') {
        flush();
        const id = e.marker.taskId ?? `task-${groups.length + 1}`;
        current = { key: id, title: id, done: false, events: [] };
      } else if (e.marker.type === 'task_complete') {
        current.done = true;
        if (e.marker.summary) current.summary = e.marker.summary;
      } else if (e.marker.type === 'phase_complete') {
        current.done = true;
      }
      continue;
    }
    current.events.push(e);
  }
  flush();
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/ui/tests/unit/lib/trajectory-grouping.test.ts`
Expected: PASS.

### 6B — Store

- [ ] **Step 5: Write the failing store test**

Create `apps/ui/tests/unit/store/trajectory-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTrajectoryStore } from '../../../src/store/trajectory-store';
import type { NormalizedEvent } from '@aboardai/types';

const ev = (id: string, ts: string): NormalizedEvent => ({
  v: 1,
  id,
  ts,
  kind: 'agent_message',
  provider: 'claude',
  text: 'x',
});

describe('useTrajectoryStore', () => {
  beforeEach(() => useTrajectoryStore.setState({ eventsByFeature: {} }));

  it('appends events and dedupes by id:ts', () => {
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1'));
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1')); // dup
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't2')); // same id, diff ts → kept
    expect(useTrajectoryStore.getState().eventsByFeature['f1']).toHaveLength(2);
  });

  it('clear removes a feature', () => {
    useTrajectoryStore.getState().appendEvent('f1', ev('0001', 't1'));
    useTrajectoryStore.getState().clear('f1');
    expect(useTrajectoryStore.getState().eventsByFeature['f1']).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run apps/ui/tests/unit/store/trajectory-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the store**

Create `apps/ui/src/store/trajectory-store.ts` (mirrors `group-store.ts` style: bare `create`, no persist):

```ts
import { create } from 'zustand';
import type { NormalizedEvent } from '@aboardai/types';
import { getHttpApiClient } from '@/lib/http-api-client';

const dedupeKey = (e: NormalizedEvent): string => `${e.id}:${e.ts}`;

interface TrajectoryStoreState {
  eventsByFeature: Record<string, NormalizedEvent[]>;
}

interface TrajectoryStoreActions {
  load(projectPath: string, featureId: string): Promise<void>;
  appendEvent(featureId: string, event: NormalizedEvent): void;
  registerFeatureEvents(): () => void;
  clear(featureId: string): void;
}

export const useTrajectoryStore = create<TrajectoryStoreState & TrajectoryStoreActions>()(
  (set, get) => ({
    eventsByFeature: {},

    load: async (projectPath: string, featureId: string) => {
      const api = getHttpApiClient();
      const res = await api.features.getEvents(projectPath, featureId);
      if (res.success && res.events) {
        set((s) => ({ eventsByFeature: { ...s.eventsByFeature, [featureId]: res.events! } }));
      }
    },

    appendEvent: (featureId: string, event: NormalizedEvent) => {
      const cur = get().eventsByFeature[featureId] ?? [];
      const key = dedupeKey(event);
      if (cur.some((e) => dedupeKey(e) === key)) return;
      set((s) => ({ eventsByFeature: { ...s.eventsByFeature, [featureId]: [...cur, event] } }));
    },

    registerFeatureEvents: (): (() => void) => {
      const api = getHttpApiClient();
      return api.features.onFeatureEvent((payload) => {
        get().appendEvent(payload.featureId, payload.event);
      });
    },

    clear: (featureId: string) =>
      set((s) => {
        const next = { ...s.eventsByFeature };
        delete next[featureId];
        return { eventsByFeature: next };
      }),
  })
);
```

- [ ] **Step 8: Run store test to verify it passes**

Run: `npx vitest run apps/ui/tests/unit/store/trajectory-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/lib/trajectory-grouping.ts apps/ui/src/store/trajectory-store.ts apps/ui/tests/unit/lib/trajectory-grouping.test.ts apps/ui/tests/unit/store/trajectory-store.test.ts
git commit -m "[feat] trajectory store slice + phase grouping helper"
```

---

## Task 7: Trajectory components

**Files:**

- Create: `apps/ui/src/components/views/board-view/trajectory/diff-view.tsx`
- Create: `apps/ui/src/components/views/board-view/trajectory/event-card.tsx`
- Create: `apps/ui/src/components/views/board-view/trajectory/trajectory-view.tsx`
- Test: `apps/ui/tests/unit/components/trajectory-view.test.tsx` (create)

### 7A — Diff view (hand-rolled, no new dependency)

- [ ] **Step 1: Implement the diff view**

Create `apps/ui/src/components/views/board-view/trajectory/diff-view.tsx`:

```tsx
import type { FileDiff } from '@aboardai/types';

export function DiffView({ diff }: { diff: FileDiff }) {
  const rows = diff.unified.split('\n');
  return (
    <pre className="mt-1 text-xs font-mono whitespace-pre-wrap rounded-md bg-muted/50 p-2 overflow-x-auto">
      {rows.map((line, i) => {
        const cls = line.startsWith('+')
          ? 'text-green-500'
          : line.startsWith('-')
            ? 'text-red-500'
            : 'text-muted-foreground';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
      {diff.truncated && <div className="text-muted-foreground italic">… diff truncated</div>}
    </pre>
  );
}
```

### 7B — Event card (one component, switches on kind)

- [ ] **Step 2: Write the failing component test**

Create `apps/ui/tests/unit/components/trajectory-view.test.tsx`:

```tsx
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/ui/tests/unit/components/trajectory-view.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the event card**

Create `apps/ui/src/components/views/board-view/trajectory/event-card.tsx`:

```tsx
import { useState } from 'react';
import type { NormalizedEvent } from '@aboardai/types';
import { DiffView } from './diff-view';

const pill = 'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium';

export function EventCard({ event }: { event: NormalizedEvent }) {
  const [open, setOpen] = useState(false);

  switch (event.kind) {
    case 'thinking':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1">
          <button
            className="flex items-center gap-2 text-xs w-full text-left"
            onClick={() => setOpen((o) => !o)}
          >
            <span className={`${pill} bg-amber-500/20 text-amber-600`}>thinking</span>
            <span className="text-muted-foreground">{open ? 'hide' : 'reasoning'}</span>
          </button>
          {open && event.text && (
            <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{event.text}</p>
          )}
        </div>
      );

    case 'command_run':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span className={`${pill} bg-blue-500/20 text-blue-600 mr-2`}>run</span>
          <code className="font-mono">{event.command?.command}</code>
        </div>
      );

    case 'file_edit':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setOpen((o) => !o)}
          >
            <span className={`${pill} bg-purple-500/20 text-purple-600`}>edit</span>
            <code className="font-mono">{event.file?.path}</code>
            {event.file?.diff && (
              <span className="ml-auto font-mono text-muted-foreground">
                <span className="text-green-500">+{event.file.diff.adds}</span>{' '}
                <span className="text-red-500">−{event.file.diff.dels}</span>
              </span>
            )}
          </button>
          {open && event.file?.diff && <DiffView diff={event.file.diff} />}
        </div>
      );

    case 'tool_result':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span className={`${pill} bg-emerald-500/20 text-emerald-600 mr-2`}>output</span>
          <pre className="mt-1 font-mono whitespace-pre-wrap text-muted-foreground">
            {event.text}
            {event.textTruncated && <span className="italic"> … truncated</span>}
          </pre>
        </div>
      );

    case 'result':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span
            className={`${pill} ${event.result?.isError ? 'bg-red-500/20 text-red-600' : 'bg-zinc-500/20'} mr-2`}
          >
            result
          </span>
          {event.result?.isError ? 'Error' : 'Complete'}
        </div>
      );

    case 'agent_message':
    case 'summary':
    case 'error':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs whitespace-pre-wrap">
          <span className={`${pill} bg-zinc-500/20 mr-2`}>
            {event.kind === 'error' ? 'error' : 'message'}
          </span>
          {event.text}
        </div>
      );

    default:
      // tool_use / question / status / session — compact generic line (forward-compatible)
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-1.5 my-1 text-xs text-muted-foreground">
          <span className={`${pill} bg-zinc-500/20 mr-2`}>{event.kind}</span>
          {event.tool?.name ?? event.status?.status ?? ''}
        </div>
      );
  }
}
```

- [ ] **Step 5: Implement the trajectory view (grouping + collapse)**

Create `apps/ui/src/components/views/board-view/trajectory/trajectory-view.tsx`:

```tsx
import { useState } from 'react';
import type { NormalizedEvent } from '@aboardai/types';
import { groupTrajectory } from '@/lib/trajectory-grouping';
import { EventCard } from './event-card';

export function TrajectoryView({ events }: { events: NormalizedEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">No activity recorded yet.</div>
    );
  }

  const groups = groupTrajectory(events);
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
  children: React.ReactNode;
}) {
  // Done groups start collapsed; the active (not-done) group starts expanded.
  const [open, setOpen] = useState(!done);
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
```

- [ ] **Step 6: Run component tests to verify they pass**

Run: `npx vitest run apps/ui/tests/unit/components/trajectory-view.test.tsx`
Expected: PASS. (If the `−` minus-sign assertion is finicky, adjust the test to match the rendered character — the implementation uses `−` U+2212.)

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/components/views/board-view/trajectory/ apps/ui/tests/unit/components/trajectory-view.test.tsx
git commit -m "[feat] trajectory view components (cards, diff view, phase grouping UI)"
```

---

## Task 8: Wire trajectory into the agent-output modal as default tab

**Files:**

- Modify: `apps/ui/src/components/views/board-view/dialogs/agent-output-modal.constants.ts`
- Modify: `apps/ui/src/components/views/board-view/dialogs/agent-output-modal.tsx`

- [ ] **Step 1: Add the view mode constant**

In `agent-output-modal.constants.ts`, add `TRAJECTORY` to `VIEW_MODES`:

```ts
  VIEW_MODES: {
    TRAJECTORY: 'trajectory',
    SUMMARY: 'summary',
    PARSED: 'parsed',
    RAW: 'raw',
    CHANGES: 'changes',
  } as const,
```

- [ ] **Step 2: Make trajectory the default + load/subscribe**

In `agent-output-modal.tsx`:

(a) Add imports near the top:

```ts
import { TrajectoryView } from '../trajectory/trajectory-view';
import { useTrajectoryStore } from '@/store/trajectory-store';
import { Activity } from 'lucide-react';
```

(b) Change the `effectiveViewMode` fallback (the line that resolves the default ~231) so trajectory is the default:

```ts
const effectiveViewMode = viewMode ?? MODAL_CONSTANTS.VIEW_MODES.TRAJECTORY;
```

(c) Inside the component body, read events for this feature and wire load + live subscription:

```ts
const trajectoryEvents = useTrajectoryStore((s) => s.eventsByFeature[featureId] ?? []);

useEffect(() => {
  if (!resolvedProjectPath) return;
  const store = useTrajectoryStore.getState();
  void store.load(resolvedProjectPath, featureId);
  const unsub = store.registerFeatureEvents();
  return () => unsub();
}, [featureId, resolvedProjectPath]);
```

(Place this near the other `useEffect` hooks; `useEffect` is already imported in this file.)

- [ ] **Step 3: Add the tab button**

In the tab button container (~lines 534-585), add a Trajectory button as the **first** button (mirror the existing parsed/Logs button structure):

```tsx
<button
  onClick={() => setViewMode('trajectory')}
  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
    effectiveViewMode === 'trajectory'
      ? 'bg-primary/20 text-primary shadow-sm'
      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
  }`}
  data-testid="view-mode-trajectory"
>
  <Activity className="w-3.5 h-3.5" />
  Trajectory
</button>
```

- [ ] **Step 4: Add the tab content branch**

At the front of the content ternary chain (~line 604, before the `changes` branch) add:

```tsx
        {effectiveViewMode === 'trajectory' ? (
          <div className="overflow-y-auto p-3">
            <TrajectoryView events={trajectoryEvents} />
          </div>
        ) : effectiveViewMode === 'changes' ? (
```

(Keep the rest of the chain intact — this just prepends one branch.)

- [ ] **Step 5: Typecheck + build the UI**

Run: `npm run build`
Expected: compiles clean. If `Activity` collides with an existing import name, alias it (`Activity as ActivityIcon`).

- [ ] **Step 6: Manual smoke (optional but recommended)**

Run the app (`npm run dev:web`), open a feature that has run, confirm the Trajectory tab is default and shows grouped cards. (Full automated coverage is Task 9.)

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/components/views/board-view/dialogs/agent-output-modal.tsx apps/ui/src/components/views/board-view/dialogs/agent-output-modal.constants.ts
git commit -m "[feat] mount Trajectory as default tab in agent-output modal (live + replay)"
```

---

## Task 9: E2E + full gate

**Files:**

- Create: `tests/e2e/trajectory-view.spec.ts` (mirror an existing spec's setup; e.g. an existing board/agent-output spec)

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/trajectory-view.spec.ts`. Use the project's existing E2E harness/fixtures (mock-agent mode, `ABOARDAI_MOCK_AGENT=true`). Mirror the setup of an existing spec that opens the agent-output modal. The assertions:

```ts
// Pseudocode skeleton — adapt selectors/fixtures to the existing E2E harness.
import { test, expect } from '@playwright/test';

test('agent output opens on the Trajectory tab and shows grouped activity', async ({ page }) => {
  // ... existing setup: launch app, create + run a mock feature, open its agent-output modal ...
  await expect(page.getByTestId('view-mode-trajectory')).toHaveClass(/bg-primary\/20/); // default selected
  // at least one phase group present
  await expect(page.locator('[data-testid^="phase-"]').first()).toBeVisible();
});
```

Read an existing spec (e.g. one that already drives a feature run in mock mode) first and copy its setup verbatim, then add the assertions above.

- [ ] **Step 2: Run the new E2E spec**

Run: `npm run test -- --workers=2 tests/e2e/trajectory-view.spec.ts`
Expected: PASS. Debug selectors against the real DOM if needed.

- [ ] **Step 3: Run the full unit suite**

Run: `npx vitest run`
Expected: all green (existing 3,744 + new tests). Fix any regressions from Task 3's cap/field changes.

- [ ] **Step 4: Run lint + build + packages**

Run: `npm run build:packages && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 5: Run full E2E gate**

Run: `npm run test -- --workers=2`
Expected: parity with the v1 baseline (71/74; only known flake `edit-feature.spec.ts:62`). Investigate any new failures.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/trajectory-view.spec.ts
git commit -m "[test] E2E: Trajectory tab is default and renders grouped activity"
```

- [ ] **Step 7: Update the roadmap**

Mark P1 done in `docs/superpowers/plans/2026-06-14-reference-repo-audit-roadmap.md` (section 5) and commit:

```bash
git add docs/superpowers/plans/2026-06-14-reference-repo-audit-roadmap.md
git commit -m "[docs] mark P1 trajectory view complete in roadmap"
```

---

## Self-review notes (coverage check)

- Spec §4.1 enrichment → Tasks 1-3 (types, diff-builder, normalizer). ✓
- Spec §4.2 replay endpoint → Task 4. ✓
- Spec §4.3 store/live/replay (dedupe by composite key) → Tasks 5-6. ✓
- Spec §4.4 components + default tab → Tasks 7-8. ✓
- Spec §6 edge cases: empty state (Task 7 TrajectoryView), torn tail (reuses `readEventLog`), oversized caps (Tasks 2-3), unknown kinds (EventCard `default` branch), diff-build failure → undefined (Task 2), dedupe (Task 6). ✓
- Spec §7 testing: unit (Tasks 1-7), E2E @ workers=2 (Task 9). ✓
- No new UI dependency (diff hand-rolled) → optimizeDeps guard not triggered. ✓

```

```
