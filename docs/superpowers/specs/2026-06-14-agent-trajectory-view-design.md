# Agent Trajectory View — Design Spec

**Date:** 2026-06-14
**Status:** Approved (brainstorming) — ready for implementation plan
**Roadmap item:** P1 in `docs/superpowers/plans/2026-06-14-reference-repo-audit-roadmap.md`
**Goal:** Replace the flat, re-parsed text log of agent activity with a structured, phase-grouped
"trajectory" view — the single highest-leverage change to stop the app feeling like automaker.

---

## 1. Problem & context

Today the UI shows agent activity as a flat scrolling log: the legacy `AutoModeEvent` text stream plus
the rendered `agent-output.md` markdown blob, accumulated as a string and re-parsed back into log sections
(`apps/ui/src/components/views/board-view/dialogs/agent-output-modal.tsx` →
`apps/ui/src/components/ui/log-viewer.tsx`). It has no diffs, no collapsing, no structure.

Meanwhile a rich, structured `NormalizedEvent` pipeline was built in Phase 3
(`libs/types/src/normalized-event.ts`, `apps/server/src/events/normalizer.ts`, `event-log.ts` →
`events.jsonl`) but **was never wired to the UI**. There are effectively two parallel event systems.

This spec unifies on the normalized pipeline for the agent-activity view, enriches it to carry the data a
good trajectory needs, and builds the structured UI on top.

**Key enabling fact (verified in `normalizer.ts`):** the data we want is already in hand at the
normalizer and merely discarded —

- `block.input` carries the full Edit/Write/MultiEdit payload → a real diff can be computed at emit time.
- `block.thinking` carries the full thinking text; line ~202-204 deliberately keeps only `.length`.
- tool output is merely truncated at `TOOL_RESULT_MAX_CHARS = 500`.

So "do it right" is mostly _stop discarding + correlate_, not re-architect plumbing.

## 2. Scope

**In scope**

- Enrich `NormalizedEvent` to carry: file diffs (file_edit), thinking text (thinking), fuller command/tool
  output, and a `toolUseId` on `tool_result` for output↔action correlation. All fields additive/optional.
- A replay endpoint that serves a run's `events.jsonl` as `NormalizedEvent[]`.
- A frontend store slice + hook consuming the `feature:event` WS broadcast (live) and the replay endpoint
  (past runs).
- A `TrajectoryView` component: phase-grouped, collapsible, one card per event kind, with inline diffs and
  expandable thinking/output. New default tab in `agent-output-modal.tsx`.

**Out of scope (later roadmap items)**

- Inline diff _comments_ / batched agent feedback loop (P2).
- Risk-gating / approval buttons (P4) — but the event UI built here is what P4 will hang off.
- Multi-attempt / forking (P3).
- Retiring the legacy `AutoModeEvent` path elsewhere in the app (only the agent-activity view migrates here).

## 3. Decisions (settled in brainstorming)

- **Layout:** grouped by phase (Planning / Implementation / Verification), collapsible. Finished phases
  collapse to a one-line ✓ summary; the active phase stays expanded and streams live. (Chosen over flat
  timeline.)
- **Thinking text:** shown but **collapsed by default** (can be long); expandable per block.
- **Placement:** "Trajectory" is the **new default tab**; existing Summary / Raw / Changes tabs remain.
- **Fidelity ceiling ("do it right"):** unify on the normalized pipeline and enrich it, rather than build
  on the legacy stream or merely restyle.

## 4. Architecture

### 4.1 Event enrichment (backend) — `libs/types/src/normalized-event.ts` + `normalizer.ts`

Add optional fields (additive — existing `events.jsonl` keeps parsing; golden fixtures gain new cases):

- `file_edit.file.diff?: { unified: string; adds: number; dels: number; truncated: boolean }`
  - Computed from `block.input`: Edit (`old_string`/`new_string`), Write (whole `content` as all-adds),
    MultiEdit (concatenate per-edit diffs), NotebookEdit (best-effort).
  - Capped at ~8 KB of unified-diff text; set `truncated: true` and keep accurate adds/dels counts when over.
- `thinking.text?: string` — full thinking text, capped ~4 KB with a `thinkingTruncated?: boolean` flag.
  Keep existing `thinkingChars` for backward compatibility.
- `tool_result` output — raise the 500-char cap (`TOOL_RESULT_MAX_CHARS`) to a configurable limit (~4 KB)
  with an overflow flag; **do not silently truncate** — the UI shows "+N more lines/chars". (Command stdout
  and edit confirmations arrive as `tool_result` events, not on `command_run`/`file_edit` themselves.)
- `tool_result.toolUseId?: string` — populated from the tool_result block's `tool_use_id` where available,
  so the UI pairs each output back to the `command_run` / `file_edit` / `tool_use` that produced it (which
  already carry `tool.toolUseId`).

A small pure helper `buildDiff(input, toolName)` (new file, e.g. `events/diff-builder.ts`) owns diff
construction and is unit-tested in isolation.

### 4.2 Replay endpoint (backend)

`GET /api/features/:id/events` → `{ events: NormalizedEvent[] }`, reading the feature's `events.jsonl` via
the existing torn-tail-tolerant reader in `event-log.ts` (`readEventLog`). Returns `[]` if no log yet.
Route lives under the existing features routes.

### 4.3 Frontend data flow

- **Store:** a new Zustand slice `apps/ui/src/store/trajectory-store.ts` keyed by `featureId` holding
  `NormalizedEvent[]` + derived phase grouping. **Not** added to `app-store.ts` (monolith rule from the
  project plan: new UI state goes in new slices).
- **Live:** subscribe to the existing `feature:event` WS broadcast (currently no-op'd at
  `http-api-client.ts` ~L938). Add `'feature:event'` to the client `EventType` union and route it into the
  store (append by `featureId`, dedupe by event `id`).
- **Replay:** on opening the modal, fetch the replay endpoint to seed the store, then live events append.
  Seed + live dedupe by monotonic event `id`.

### 4.4 Frontend components

- `TrajectoryView` (container): reads the store slice, groups events into phases by `task_marker` events
  (phase boundaries) with a leading "ungrouped" bucket; renders collapsible phase sections; virtualizes the
  event list for long runs.
- One small presentational component per event kind:
  `CommandCard`, `EditCard` (+ a lightweight unified-diff renderer), `ToolCard`, `ThinkingBlock`,
  `MessageCard`, `ResultCard`, `StatusCard`, `QuestionCard`. Each is independently renderable/testable.
- Mounted as the new default tab in `agent-output-modal.tsx`; other tabs unchanged.

## 5. Data flow (end to end)

```
SDK ProviderMessage
  → normalizer.feed()  [now also: diff, thinking text, fuller output, toolUseId]
  → event-log append (events.jsonl)  +  WS 'feature:event' broadcast
        │                                     │
   replay endpoint (GET .../events)      live WS subscription
        └───────────────┬─────────────────────┘
                  trajectory-store (Zustand slice, keyed by featureId, dedupe by id)
                        → TrajectoryView (phase grouping)
                        → per-kind cards
```

## 6. Error handling & edge cases

- **No `events.jsonl` yet** (old features pre-pipeline, or run not started): replay returns `[]`; view shows
  an empty/"no activity recorded" state and still accepts live events.
- **Torn tail / partial last line:** handled by existing `readEventLog` tolerance.
- **Oversized payloads:** caps with explicit overflow indicators; never silently drop.
- **Unknown future event kinds:** cards default to a generic renderer (forward-compatible), matching the
  existing "UI no-ops unknown types" posture.
- **Diff build failure** (unexpected input shape): emit `file_edit` without `diff` (path-only, as today) —
  enrichment is best-effort and never breaks the event.
- **Dedup:** seed (replay) + live can overlap; dedupe by event `id`.

## 7. Testing

- **Unit (Vitest, server/types):** `buildDiff` for Edit/Write/MultiEdit + cap/overflow; normalizer emits
  enriched fields; thinking text cap; tool_result `toolUseId` correlation; replay endpoint round-trip
  (write events.jsonl → GET → assert shape). Extend existing golden fixtures
  (`libs/types/tests/unit/normalized-event.test.ts`, normalizer tests) with enriched cases; assert old
  fixtures still parse.
- **Component (UI):** render each event-kind card; phase grouping + collapse/expand; diff renderer
  adds/dels; thinking collapsed-by-default then expand.
- **E2E (Playwright @ --workers=2):** mock-agent feature run → open feature → Trajectory tab is default →
  shows phase groups with at least one EditCard diff and one CommandCard with output. Never run at default
  8 workers on this machine (project rule).

## 8. Risks

- **`events.jsonl` size growth** from richer payloads — mitigated by caps; acceptable for v1.
- **Diff builder correctness** across the four edit tools — isolated, heavily unit-tested.
- **WS event-type wiring** touches `http-api-client.ts` (large, shared) — change is additive (one union
  member + one route), guarded by the existing connection tests.
- **Vite optimizeDeps rule:** any _new_ UI dependency (e.g. a diff renderer lib, if used instead of a
  hand-rolled one) MUST be added to `optimizeDeps.include` in `apps/ui/vite.config.mts` — enforced by
  `apps/ui/tests/unit/vite-optimize-deps.test.ts`. Prefer a hand-rolled lightweight diff renderer to avoid
  a new dependency.

## 9. Success criteria

- Opening any feature (live or completed) shows a phase-grouped trajectory with collapsible phases,
  per-action cards, inline diffs, and expandable thinking — replacing the flat log as the default view.
- Past runs replay correctly from `events.jsonl`.
- All existing unit/E2E suites stay green; new tests cover enrichment, replay, and rendering.
- The agent-activity view consumes the normalized pipeline (no markdown re-parse for this view).
