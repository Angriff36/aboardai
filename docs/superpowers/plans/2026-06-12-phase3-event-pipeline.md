# Phase 3: Normalized Event Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map every streamed provider message to a typed `NormalizedEvent`, append events crash-safely to `{feature}/events.jsonl`, broadcast them over the existing WebSocket, make the auto-mode engine read task/summary markers from the normalized stream instead of re-scanning raw text, and teach recovery to replay `events.jsonl`.

**Architecture:** All providers already emit the shared `ProviderMessage` shape (Phase 2 scout-verified), so normalization is ONE core transformer (`NormalizedEventStream`) with small per-provider quirk hooks — not N parallel normalizers. Marker detection (the `[TASK_START]`/`[TASK_COMPLETE]`/`[PHASE_COMPLETE]`/`<summary>` sentinels) moves INTO the normalizer as stateful streaming detection (markers can split across text chunks), emitting `task_marker`/`summary` events; spec-parser's regexes remain the single pattern source. The engine consumes those events; prompt-visible markers are unchanged (prompts depend on them). `agent-output.md` keeps being written (UI log-parser and recovery fallback depend on it) — `events.jsonl` is the additive, structured source of truth.

**Tech Stack:** TypeScript, Vitest. New module dir `apps/server/src/events/`. JSONL appends via `secureFs.appendFile` (retry-wrapped, the `raw-output.jsonl` debounce pattern at agent-executor.ts L159-188 is the model). Branch `phase3-event-pipeline` off main (@ 6a2cf03), merge at gate.

**Spec:** Component 3 + Component 2 work-item 2 in `docs/superpowers/specs/2026-06-11-aboardai-v1-design.md`.

**Non-goals (this phase):** UI activity-feed visual revamp (Phase 5 — this phase only delivers the broadcast and verifies UI tolerance); chat-session (agent-service) normalization (feature executions only); removing agent-output.md; ideation streams.

---

## Established facts (scout-verified 2026-06-12, do not re-derive)

- WebSocket: `createEventEmitter()` (apps/server/src/lib/events.ts L18-39, in-memory Set of callbacks) bridged at index.ts L596-630 to `/api/events`; wire envelope `{ type: EventType, payload }`. EventType union lives in libs/types/src/event.ts (L5-97, ~97 variants).
- agent-executor.ts: accumulates text blocks into `responseText`/`taskOutput` (L589-600), runs `detectTaskStartMarker` (L602-611), `detectTaskCompleteMarker` (L614-624), `detectPhaseCompleteMarker` (L626-633) on accumulated text; `extractSummary(sessionContent)` at L465. Writes `agent-output.md` debounced 500ms (L143-169) and debug `raw-output.jsonl` NDJSON when `ABOARDAI_DEBUG_RAW_OUTPUT=true` (L145, L171-188).
- Marker regexes/extraction live in apps/server/src/services/spec-parser.ts (L98-139 markers, L196-251 summary priority chain).
- `ProviderMessage`/`ContentBlock` types: libs/types/src/provider.ts L262-281 (`type: 'assistant'|'user'|'error'|'result'|'supervisor_status'`; ContentBlock `type: 'text'|'tool_use'|'thinking'|'tool_result'`).
- Recovery: recovery-service.ts reads whole `agent-output.md` (L221-225) into a continuation prompt; execution-state.json shape at L29-37.
- Event-history-service is a SEPARATE concern (hook events, per-event JSON files + index) — do not touch.
- secureFs.appendFile (real implementation at libs/platform/src/secure-fs.ts L267-279; apps/server/src/lib/secure-fs.ts is a re-export shim): path-validated, retry on ENFILE/EMFILE.
- UI tolerance pre-verified: apps/ui/src/lib/http-api-client.ts L938-940 — WS onmessage does `eventCallbacks.get(data.type)`; unknown types no-op. 'feature:event' cannot crash the UI.
- UI: log-parser.ts parses text formats from agent-output content; WS consumers switch on event type and ignore unknown types (verified in Phase 2 Task 7 for agent events; re-verify for the new type in Task 4).
- Tool semantics for derived kinds: tool_use name `Edit|Write|MultiEdit|NotebookEdit` → file_edit; `Bash` → command_run; `AskUserQuestion` → question.
- Baselines @ main 6a2cf03: 3,501 server + 278 lib unit tests; E2E 70/74 @ --workers=2 (2 known deterministic failures: board-background-persistence.spec.ts:41/:444).

## NormalizedEvent design (normative)

```typescript
// libs/types/src/normalized-event.ts
export type NormalizedEventKind =
  | 'agent_message' // text content from assistant
  | 'thinking' // thinking block (content elided to length only by default)
  | 'tool_use' // any tool invocation (raw name + input summary)
  | 'tool_result' // tool result (truncated content)
  | 'file_edit' // derived: Edit/Write/MultiEdit/NotebookEdit tool_use (path extracted)
  | 'command_run' // derived: Bash tool_use (command extracted)
  | 'question' // derived: AskUserQuestion tool_use
  | 'task_marker' // [TASK_START]/[TASK_COMPLETE]/[PHASE_COMPLETE] detected in streamed text
  | 'summary' // <summary>/## Summary extracted at stream end
  | 'status' // supervisor_status passthrough (stalled/reconnecting/resumed/...)
  | 'session' // session_id observed/changed
  | 'error' // error message or error-result
  | 'result'; // terminal result (subtype, success/error)

export interface NormalizedEvent {
  v: 1; // schema version
  id: string; // monotonic per-stream: `${seq}` zero-padded
  ts: string; // ISO timestamp
  kind: NormalizedEventKind;
  provider: string; // provider name ('claude', 'codex', ...)
  featureId?: string;
  // kind-specific payload (one of):
  text?: string; // agent_message (chunk), summary, error
  tool?: { name: string; inputPreview?: string; toolUseId?: string };
  file?: { path: string; tool: string };
  command?: { command: string };
  marker?: {
    type: 'task_start' | 'task_complete' | 'phase_complete';
    taskId?: string;
    phase?: number;
    summary?: string;
  };
  status?: { status: string; attempt?: number; retryAfterMs?: number; detail?: string };
  sessionId?: string;
  result?: { subtype?: string; isError: boolean };
  thinkingChars?: number; // thinking: length only (content not persisted by default)
}
```

Both `file_edit`/`command_run`/`question` AND the generic `tool_use` are emitted for the same tool_use block (generic first, derived second) — consumers filter by kind. `task_marker` events are deduplicated per stream by (marker.type + taskId/phase). New `EventType` wire value: `'feature:event'` with payload `{ featureId, projectPath, event: NormalizedEvent }`.

events.jsonl: one NormalizedEvent JSON per line at `{projectPath}/.aboardai/features/{featureId}/events.jsonl`. Appends batched with a 150ms debounce AND force-flushed on `result`/`error`/`status(interrupted|fatal)`/stream end. Reader is torn-tail-tolerant (a partial last line from a crash is skipped, never throws).

---

### Task 0: Branch + types — _Haiku_

**Files:** Create `libs/types/src/normalized-event.ts`; Modify `libs/types/src/event.ts` (add `'feature:event'` to EventType), `libs/types/src/index.ts` (re-export); test in libs/types/tests/.

- [ ] 0.1 Branch is created by the orchestrator (`phase3-event-pipeline`). Verify you are on it.
- [ ] 0.2 Add the NormalizedEvent module EXACTLY as in the design block above (plus brief JSDoc). Add `'feature:event'` to the EventType union following its file's grouping conventions.
- [ ] 0.3 Type-level test (assignability of each kind's payload combo) + build + lib tests green (`npm run build -w @aboardai/types && npm test -w @aboardai/types`).
- [ ] 0.4 Commit `[phase3] NormalizedEvent types + feature:event wire type`.

### Task 1: NormalizedEventStream (core normalizer) + golden fixtures — _Sonnet, TDD_

**Files:** Create `apps/server/src/events/normalizer.ts`; Create `apps/server/tests/unit/events/normalizer.test.ts` + `apps/server/tests/unit/events/fixtures/*.json`.

- [ ] 1.1 Write golden fixtures FIRST (red): for each scenario a `{ input: ProviderMessage[], expected: NormalizedEvent[] }` JSON pair (timestamps/ids asserted structurally, not literally):
  - claude-basic: init system msg (session) → assistant text → tool_use(Read) → tool_result → result(success). Expect session, agent_message, tool_use, tool_result, result.
  - claude-file-and-command: tool_use(Edit with file_path), tool_use(Bash with command) → expect tool_use+file_edit and tool_use+command_run pairs.
  - claude-thinking: thinking block → thinking event with thinkingChars, no content leak.
  - markers-split-chunks: text chunks `'...[TASK_ST'`, `'ART] T001\n'`, work, `'[TASK_COMPLETE] T001: done\n'` → exactly ONE task_start(T001) + ONE task_complete(T001, summary 'done') in correct positions; re-sending overlapping accumulated text must NOT duplicate markers.
  - phase-marker + summary-extraction: `[PHASE_COMPLETE] Phase 2` mid-stream; `<summary>...</summary>` → summary event emitted at finalize().
  - supervisor-passthrough: supervisor_status(rate_limited, retryAfterMs) → status event.
  - error-result: result with is_error/subtype → result{isError:true} event (+ error event carrying message when present).
  - codex-mapped & cursor-mapped: representative ProviderMessage sequences as those providers actually yield them (derive from their unit tests' shapes) — prove the core normalizer needs no provider branching beyond `provider` labeling; if a genuine quirk emerges, add a documented quirk hook, not a fork.
- [ ] 1.2 Implement `NormalizedEventStream`: `constructor({ provider, featureId, clock? })`, `feed(msg: ProviderMessage): NormalizedEvent[]`, `finalize(): NormalizedEvent[]` (summary extraction over accumulated text via spec-parser's extractSummary), monotonic seq ids, marker detection using spec-parser regexes over an accumulated text buffer with fired-marker dedup set. Import detection patterns from spec-parser — do NOT duplicate regexes. SESSION-SLICE SEMANTICS: the stream's accumulated buffer starts at stream start, which equals the "current session slice" the executor's extractAndSaveSessionSummary uses (`responseText.substring(previousContent.length)`) — finalize() must NOT be fed pre-existing previousContent (continuation runs construct a fresh NormalizedEventStream per run).
- [ ] 1.3 All fixture tests green; chunk-boundary and dedup tests explicitly named. Commit `[phase3] NormalizedEventStream + golden fixtures`.

### Task 2: EventLog writer/reader — _Sonnet, TDD_

**Files:** Create `apps/server/src/events/event-log.ts`; Create `apps/server/tests/unit/events/event-log.test.ts`.

- [ ] 2.1 Tests first: append batching (150ms debounce, fake timers), force-flush triggers (result/error/interrupted/fatal status/close()), file location `{projectPath}/.aboardai/features/{featureId}/events.jsonl` via the platform path helpers (use getFeatureDir from @aboardai/platform — check its actual export name), torn-tail reader (write valid lines + half a line → read returns valid events, no throw), concurrent-feature isolation (two writers, two files).
- [ ] 2.2 Implement `EventLogWriter` (append via secureFs.appendFile, debounce+flush, close() flushes; the in-memory line buffer is RESET after each flush, appending to the same file across flushes — same model as raw-output.jsonl at agent-executor.ts L171-188) and `readEventLog(projectPath, featureId): Promise<NormalizedEvent[]>` (tolerant parse, skips schema-version mismatches with a warn).
- [ ] 2.3 Green. Commit `[phase3] EventLog JSONL writer/reader (crash-tolerant)`.

### Task 3: Engine wiring — _Sonnet (the delicate one)_

**Files:** Modify `apps/server/src/services/agent-executor.ts`; possibly `apps/server/src/services/typed-event-bus.ts` (only if a helper is natural); tests.

- [ ] 3.1 In each agent-executor stream loop (the 4 supervised call sites): instantiate `NormalizedEventStream` + `EventLogWriter` per run; for every ProviderMessage: `const evts = stream.feed(msg)`; append all to the writer; broadcast each as `events.emit('feature:event', { featureId, projectPath, event })` (find how the executor accesses the emitter — callbacks/TypedEventBus — follow existing patterns). On stream end (incl. error paths): `stream.finalize()` events also written/broadcast; `writer.close()` in a finally.
- [ ] 3.2 Replace marker-scanning internals: delete the direct `detectTaskStartMarker/detectTaskCompleteMarker/detectPhaseCompleteMarker` calls on accumulated text in the executor loops; instead react to `task_marker` events from `feed()` output — SAME downstream actions (task status updates, auto_mode_task_started/complete/phase events) with the same payloads. The summary path (extractSummary at session end) now uses the `summary` event from `finalize()` (same callback) — BUT preserve the existing pipeline-status fallback in extractAndSaveSessionSummary: when finalize() yields no summary event, the executor's current fallback (using cleaned sessionContent) still runs, exactly as today. `agent-output.md` accumulation/writing is UNCHANGED.
- [ ] 3.3 Existing executor unit tests must stay green UNCHANGED (behavior-equivalence proof). If a test asserted internal call mechanics (spies on spec-parser functions), updating the spy target is acceptable with a one-line note; assertions on OUTCOMES must not change.
- [ ] 3.4 New tests: one executor-level test asserting events.jsonl is written during a FakeProvider run (markers included) and that 'feature:event' emissions occurred (spy on emitter); one asserting writer.close() flushes on abort/error.
- [ ] 3.5 UI tolerance check (read-only): confirm the UI's `/api/events` consumer ignores unknown `type` values ('feature:event') — grep apps/ui websocket subscription code; report file:line. If anything would crash, STOP and report.
- [ ] 3.6 Full server suite green. Commit `[phase3] engine consumes normalized events; markers via pipeline; events.jsonl live`.

### Task 4: Recovery replay — _Sonnet_

**Files:** Modify `apps/server/src/services/recovery-service.ts`; tests.

- [ ] 4.1 When resuming a feature: if `events.jsonl` exists and parses to ≥1 event, build the continuation context from a structured replay — render events to a compact text transcript (agent_message text joined, tool_use one-liners `→ Tool(name): inputPreview`, task_marker lines verbatim as their original sentinel text, last result/status) capped to the same size budget the current agent-output.md path uses (find the existing cap; if none, cap at ~30k chars from the tail). If events.jsonl is absent/empty/unreadable → existing agent-output.md path unchanged (fallback proven by test).
- [ ] 4.2 Tests: replay-from-events (assert rendered context contains marker lines + last messages), torn-tail file still resumes, fallback path when no events.jsonl.
- [ ] 4.3 Full suite green. Commit `[phase3] recovery replays events.jsonl with agent-output.md fallback`.

### Task 5: Phase gate — _Sonnet_

- [ ] 5.1 Formal gate: `npm run build:packages && npm run lint`, `npx vitest run` (apps/server) + `npm test --workspaces --if-present`, `npm run build`. Record numbers (baseline 3,501/278).
- [ ] 5.2 E2E @ `--workers=2`: ≥70 passed; failures only within {board-background-persistence.spec.ts:41, :444} + documented flakes (phase1-baseline.md).
- [ ] 5.3 Live smoke: dev:server up → health 200 → confirm no startup errors from the new module; ALSO run one mock-agent feature execution if there's an existing scripted path (check how E2E boots features in mock mode — if trivial to trigger via API: POST a feature, run it with ABOARDAI_MOCK_AGENT=true, then assert `{feature}/events.jsonl` exists with ≥2 events incl. a result). If not trivial, note it — the executor unit test from 3.4 covers the mechanism. `npx kill-port 3008` after.
- [ ] 5.4 Update tasks/todo.md (Phase 3 section) + append gate numbers to a new `docs/superpowers/plans/phase3-results.md`. Merge `phase3-event-pipeline` → main (no-ff) `[phase3] normalized event pipeline complete — gate green`.

---

## Execution notes for the orchestrator

- Sequential: 0 → 1 → 2 → 3 → 4 → 5 (Task 2 may run parallel to Task 1 ONLY if different agents avoid the same checkout — default sequential, same checkout).
- Models: Task 0 Haiku; Tasks 1-5 Sonnet. No competition (spec assigns Phase 3 to Sonnet).
- Hard rules: never change prompt-visible sentinel formats; spec-parser regexes are the single pattern source; agent-output.md writing unchanged; event-history-service untouched; supervisor/scenario tests untouched; Windows git-bash; 600000ms timeouts; `npx kill-port` only.
