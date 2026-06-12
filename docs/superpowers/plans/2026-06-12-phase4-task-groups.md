# Phase 4: Task Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship task groups: a `TaskGroup` (2–20 features, maxConcurrency slider, per-child retry, shared base branch) whose lifecycle is modeled in `@angriff36/manifest` (Amendment A2 — ADOPTED; installability gate passed 2026-06-12: v2.4.1 resolves from GitHub Packages with the user-level token; project needs only a scope→registry `.npmrc` line, NO secrets in repo). A `GroupQueue` drains children into auto-mode as slots free; groups settle to `review` (all succeed) or `failed` (per-child detail). The worktree-creation race gets a per-path mutex.

**Architecture:** Manifest is the group-lifecycle source of truth: a `taskgroup.manifest` domain model compiled to IR at server startup (`compileToIR`, cached in memory — no build-pipeline changes), executed by `RuntimeEngine` with the bundled MemoryStore; the host persists a JSON snapshot per group to `.aboardai/groups/{groupId}/group.json` after every command (atomicWriteJson — matches the repo's JSON-on-disk rule). The `GroupQueue` (plain TS service) DRIVES execution: it picks eligible children (existing `@aboardai/dependency-resolver` for feature dependencies), claims a slot via a guarded Manifest command, awaits `autoModeService.executeFeature(...)`, and reports success/failure back as commands — so illegal transitions are impossible by construction. `CommandResult.emittedEvents` flow into a per-group `events.jsonl` (reusing Phase 3's EventLogWriter, path-generalized) and broadcast as a new `'group:event'` WS type. UI = satellite `group-store.ts` + create-group dialog + groups panel, per existing conventions.

**Tech Stack:** `@angriff36/manifest` pinned EXACTLY `2.4.1` (fast-moving personal package — A2 requires pinning). TypeScript, Vitest, Playwright. Branch `phase4-task-groups` off main (@ b2ef9e3).

**Spec:** Component 4 + Amendment A2. **Fallback (contingency only):** if Manifest integration hits a wall mid-phase (Windows incompat, runtime defect), the same command/guard contract is implemented as a plain TS state machine with identical tests — the orchestrator makes that call, not implementing agents.

**Non-goals:** agent-governed board mutations via Manifest agent-sdk (A2 stretch goal — evaluate AFTER core lands, likely Phase 5); deep kanban drag-drop integration for groups (panel + dialog suffice for v1); cross-project groups; persisting Manifest audit sinks.

---

## Established facts (scout-verified 2026-06-12, do not re-derive)

- **Manifest embed:** `RuntimeEngine(ir, context, options)` (C:/Projects/Manifest/src/manifest/runtime-engine.ts L958); `runCommand(name, input, {entityName, instanceId}) → CommandResult {success, instance, error, emittedEvents[]}` (L2177); `compileToIR(source) → {ir, diagnostics}` exported from `@angriff36/manifest/ir-compiler`; MemoryStore has NO persistence (host snapshots); all peerDeps optional; `createInstance(entityName, data)` exists. Minimal example: runtime-engine.happy.test.ts. Registry: project `.npmrc` line `@angriff36:registry=https://npm.pkg.github.com` (auth from user-level npmrc — NEVER commit tokens).
- **Auto-loop:** auto-loop-coordinator.ts `runAutoLoopForProject` (L166-256); eligibility = status ∈ {backlog, ready, interrupted, pipeline\_\*} AND `areDependenciesSatisfied(f, all)` (@aboardai/dependency-resolver) AND not running; capacity via `concurrencyManager.getRunningCountForWorktree(projectPath, branchName)` vs `config.maxConcurrency`.
- **Run paths:** `autoModeService.executeFeature(projectPath, featureId, useWorktrees, isAutoMode)` (run-feature route L12-47 calls it; manual runs bypass the concurrency gate but ARE counted). Auto-loop start: `startAutoLoopForProject(projectPath, branchName, maxConcurrency)`.
- **ConcurrencyManager:** lease-based acquire/release; `getRunningCountForWorktree(projectPath, branchName, {autoModeOnly?})`; RunningFeature shape at concurrency-manager.ts L26-37.
- **Feature model:** `Feature.dependencies?: string[]`, `branchName?: string|null` (null = main worktree); statuses incl. backlog/ready/in*progress/interrupted/completed/verified/waiting_approval/pipeline*\*; restart reconciliation resets in_progress→ready/backlog (feature-state-manager L321-330).
- **Worktree race (confirmed):** routes/worktree/routes/create.ts — `findExistingWorktreeForBranch` (L151-172) then `git worktree add` (L256-267), NO locking. Path scheme: `{projectPath}/.worktrees/{sanitized}`, sanitize `[^a-zA-Z0-9_-]→'-'` (L175). worktree-resolver.ts `findWorktreeForBranch` (L77-117) parses `git worktree list --porcelain`.
- **Settings:** `GlobalSettings.autoModeByWorktree[worktreeKey].maxConcurrency`; worktreeKey `${projectId}::${branchName ?? '__main__'}`.
- **Storage:** features at `.aboardai/features/{id}/feature.json` via `atomicWriteJson(path, data, {backupCount})`; no index file; persist-before-emit pattern.
- **Phase 3 modules to reuse:** `apps/server/src/events/event-log.ts` (EventLogWriter — currently feature-path-bound via getFeatureDir), `normalizer.ts` NOT needed for groups (group events come pre-structured from Manifest).
- **UI conventions:** satellite store pattern (ideation-store.ts); add-feature-dialog.tsx as dialog analog; maxConcurrency Slider in auto-mode-settings-popover.tsx; api client methods on http-api-client.ts; WS unknown event types no-op (L938-940).
- **Baselines @ main b2ef9e3:** 3,606 unit tests / 28 skipped; E2E 70/74 @ --workers=2 (2 known deterministic failures); typecheck/lint/build clean.

## Group domain contract (normative — Manifest expresses this; tests enforce it)

Types in `@aboardai/types` (new `group.ts`): `GroupChildStatus = 'pending'|'running'|'retrying'|'completed'|'failed'|'skipped'`; `TaskGroupStatus = 'pending'|'running'|'review'|'failed'|'cancelled'`; `TaskGroupSnapshot { id, name, baseBranch: string|null, maxConcurrency, retryLimit, status, children: Array<{featureId, status: GroupChildStatus, attempts, lastError?}>, createdAt, updatedAt }`; EventType addition `'group:event'`.

Commands (exact guard predicates; every guard failure must produce a structured denial, asserted in tests):

| Command              | Input                                                               | Guards (ALL must hold)                                                                    | Effect                                                                                                                | Emits                          |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| createGroup          | id, name, baseBranch, maxConcurrency, retryLimit, childFeatureIds[] | 2 ≤ children ≤ 20; 1 ≤ maxConcurrency ≤ 10; 0 ≤ retryLimit ≤ 5; child ids unique          | status pending; children all pending, attempts 0                                                                      | group_created                  |
| startGroup           | id                                                                  | status == pending                                                                         | status running                                                                                                        | group_started                  |
| claimSlot            | id, featureId                                                       | status == running; child status ∈ {pending, retrying}; runningChildCount < maxConcurrency | child → running                                                                                                       | child_claimed                  |
| reportChildSuccess   | id, featureId                                                       | child status == running                                                                   | child → completed                                                                                                     | child_completed                |
| reportChildFailure   | id, featureId, error                                                | child status == running                                                                   | attempts+1; attempts ≤ retryLimit → child retrying ELSE child failed (lastError stored)                               | child_retrying \| child_failed |
| settleGroup          | id                                                                  | status == running; NO child ∈ {pending, retrying, running}                                | all completed → review; else failed                                                                                   | group_settled                  |
| cancelGroup          | id                                                                  | status ∈ {pending, running}                                                               | status cancelled; children ∈ {pending, retrying} → skipped (running children left for queue to report, then ignored)  | group_cancelled                |
| requeueStaleChildren | id                                                                  | status == running                                                                         | children stuck 'running' → retrying WITHOUT attempts increment (boot recovery — crashed runs don't burn retry budget) | child_requeued                 |

GroupQueue drive loop (TS, NOT in Manifest): while group running → for each free slot, pick next child whose feature's `dependencies` are satisfied (dependency-resolver against current feature states) in childIds order → `claimSlot` → `executeFeature(projectPath, featureId, useWorktrees=true, isAutoMode=false)` await → report success/failure → at quiescence (no claimable children remain and none running): IF group status is 'cancelled' → STOP (settleGroup's guard requires running; never call it after cancel); ELSE → `settleGroup`. Children whose feature dependencies can NEVER be satisfied (dependency failed outside the group) → claim then immediately reportChildFailure with error 'dependency unsatisfiable' (no execute call). Snapshot persisted after EVERY successful command; boot: load snapshots into a FRESH RuntimeEngine via `createInstance` per group snapshot (MemoryStore has NO upsert — fresh boot means empty store, so plain createInstance with the stored id is correct and sufficient; NEVER reconstruct state by replaying events.jsonl), then `requeueStaleChildren` + resume drive loops for status==running groups.

Base-branch precedence (decided): at group-creation time (API layer), children WITHOUT a `branchName` get the group's `baseBranch` written into their feature.json (permanent, board-visible — matches "shared base branch" intent); children WITH an existing branchName keep it. No executeFeature signature change.

---

### Task 0: Branch + Manifest install gate — _Sonnet_

**Files:** Create `.npmrc` (repo root, ONE line: `@angriff36:registry=https://npm.pkg.github.com`); Modify `apps/server/package.json` (add `"@angriff36/manifest": "2.4.1"` — EXACT pin, no caret).

- [ ] 0.1 Verify branch `phase4-task-groups` (orchestrator creates it). Add `.npmrc` + dependency; `npm install` (600000ms). HARD RULE: the `.npmrc` contains ONLY the registry mapping — never any token.
- [ ] 0.2 Prove the embed on Windows: a vitest smoke test at apps/server/tests/unit/groups/manifest-smoke.test.ts (keep it, it's the canary): `compileToIR` a 10-line hello entity+command source → `new RuntimeEngine(ir, {})` → createInstance → runCommand → assert success + emittedEvents. The install must succeed with the project `.npmrc` containing ONLY the registry line (validates the user-level auth split). If install OR import OR compile fails: STOP, report BLOCKED with exact errors (orchestrator decides fallback).
- [ ] 0.3 Commit `[phase4] Manifest 2.4.1 pinned + embed smoke proof (.npmrc registry mapping only)`.

### Task 1: Group types + Manifest domain model + engine wrapper — _Sonnet, TDD_

**Files:** Create `libs/types/src/group.ts` (+ index re-export, + EventType `'group:event'`); Create `apps/server/src/groups/taskgroup.manifest`, `apps/server/src/groups/group-engine.ts`, `apps/server/src/groups/group-store.ts` (snapshot persistence); Tests `apps/server/tests/unit/groups/`.

- [ ] 1.1 Types per the contract block. Lib build+tests green.
- [ ] 1.2 Write behavior tests FIRST (red) against the not-yet-written engine wrapper — one test per row of the command table INCLUDING every guard-denial case (e.g. createGroup with 1 child → denied; claimSlot at capacity → denied; reportChildFailure beyond retryLimit → child failed; settleGroup with a retrying child → denied; cancelGroup skips pending children; requeueStaleChildren doesn't increment attempts). Plus: snapshot round-trip (command → persisted JSON → reload → state identical), boot recovery (snapshot with a 'running' child → requeue → claimable again).
- [ ] 1.3 Write `taskgroup.manifest` expressing the contract (consult C:/Projects/Manifest/docs/spec + conformance fixtures for DSL syntax — READ-ONLY; `manifest validate` or compileToIR diagnostics must be clean). The DSL shape is the implementer's choice; the BEHAVIOR tests are the contract. If a contract row is genuinely inexpressible in Manifest DSL, implement that row's logic in the wrapper WITH a comment and note it in the report (do not silently move logic). Reviewer flags `requeueStaleChildren` (conditional no-increment bulk transition) as the likeliest escape-hatch candidate — that's acceptable.
- [ ] 1.4 `group-engine.ts`: startup compile (compileToIR of the bundled source, memoized; fail-fast with a clear error if diagnostics non-empty), typed wrappers for each command (translate CommandResult → typed results; guard denials → typed GroupCommandDenied errors), `getSnapshot(id)`. `group-store.ts`: persist snapshot to `{projectPath}/.aboardai/groups/{groupId}/group.json` (atomicWriteJson) after every successful command; `loadAllGroups(projectPath)`; engine state rehydration from snapshots (createInstance with stored data — verify MemoryStore upsert path per the Manifest example).
- [ ] 1.5 All green; full suite regression; commit `[phase4] TaskGroup domain model in Manifest + typed engine wrapper`.

### Task 2: Worktree per-path mutex — _Sonnet, TDD_

**Files:** Create `apps/server/src/lib/keyed-mutex.ts`; Modify `apps/server/src/routes/worktree/routes/create.ts` (+ ANY other worktree-creation call sites — find them: grep `worktree.*add|createWorktree` across services; route ALL through one guarded function, likely extracted into worktree-resolver or a small service); Tests.

- [ ] 2.1 Tests first: keyed mutex (same key serializes, different keys parallel, errors release the lock); worktree double-create race (mock execGitCommand with a delayed first call; two concurrent creates for the same branch → git `worktree add` invoked EXACTLY once, both callers get the same path); EEXIST-style git failure on add → re-resolve via findExistingWorktreeForBranch and return it (defense for cross-process races the in-process mutex can't cover).
- [ ] 2.2 Implement: `KeyedMutex.run(key, fn)` (promise-chain map, entry GC'd when chain settles). Extract `ensureWorktree(projectPath, branchName, opts)` wrapping find→create inside `mutex.run('${projectPath}::${branchName}', ...)`; route + internal callers use it.
- [ ] 2.3 Green + full suite; commit `[phase4] per-path worktree mutex (race fix) + EEXIST fallback`.

### Task 3: GroupQueue service — _Sonnet, TDD_

**Files:** Create `apps/server/src/services/group-queue.ts`; Modify `apps/server/src/events/event-log.ts` (generalize: accept an explicit dir or a path-builder so groups can write `{projectPath}/.aboardai/groups/{groupId}/events.jsonl` — additive change, feature path behavior untouched, existing tests must stay green); Tests `apps/server/tests/unit/services/group-queue.test.ts`.

- [ ] 3.1 Tests first (mock group-engine with the real contract semantics or use the real engine + temp dirs — prefer REAL engine for fidelity; mock `executeFeature` with controllable promises; fake timers):
  - drains up to maxConcurrency children concurrently, claims before executing, reports after;
  - dependency ordering: child B depends on child A's feature → B not claimed until A's feature completed;
  - retry: child fails once with retryLimit 1 → re-claimed and re-executed; fails again → child failed, siblings keep draining;
  - settle: all complete → group review + group_settled emitted; one exhausted failure → group failed with per-child detail in snapshot;
  - cancel mid-drain: no NEW claims, in-flight children's reports accepted then ignored for scheduling, group cancelled;
  - dependency-unsatisfiable child (dep feature outside group failed) → claimed+failed with dependency error, no execute call;
  - every emitted Manifest event written to the group events.jsonl AND broadcast as 'group:event' (spy emitter);
  - boot resume: snapshot with running group + stale running child → requeueStaleChildren → drive loop resumes and completes.
- [ ] 3.2 Implement GroupQueue: per-group drive loop (async, abortable); slot accounting purely via Manifest guards (claimSlot denial = no free slot → wait for a report); `executeFeature(projectPath, featureId, /*useWorktrees*/ true, /*isAutoMode*/ false)` via injected AutoModeService handle (children run on the group's baseBranch worktree semantics: set child feature's branchName to the group baseBranch before execution IF the feature has none — document the precedence: existing feature.branchName wins); wire events: writer per group + `events.emit('group:event', { projectPath, groupId, event })`. Boot hook: a `resumeGroups(projectPath)` called where recovery-service runs (find the boot path; co-locate the call).
- [ ] 3.3 Green + full suite; commit `[phase4] GroupQueue drains groups through auto-mode (retry, settle, resume)`.

### Task 4: API routes — _Sonnet_

**Files:** Create `apps/server/src/routes/groups/` (index.ts + routes/{create,list,get,start,cancel}.ts following an existing routes/ feature dir as the template); Modify `apps/server/src/index.ts` (mount `/api/groups`); Route tests following existing route-test patterns.

- [ ] 4.1 POST /api/groups/create {projectPath, name, baseBranch, maxConcurrency, retryLimit, featureIds[]} → validates features exist + are group-eligible (status backlog/ready), then createGroup; GET /api/groups/list?projectPath; GET /api/groups/get?projectPath&groupId (snapshot); POST /api/groups/start {projectPath, groupId} (startGroup + kick GroupQueue drive); POST /api/groups/cancel. Guard denials → HTTP 409 with the structured denial; validation failures → 400.
- [ ] 4.2 Route tests: happy paths + 409 on bad transitions + 400 on bad input. Full suite green. Commit `[phase4] /api/groups routes`.

### Task 5: UI — _Sonnet_

**Files:** Create `apps/ui/src/store/group-store.ts` (satellite-store convention per ideation-store.ts); Create `apps/ui/src/components/views/board-view/dialogs/create-group-dialog.tsx` (analog: add-feature-dialog.tsx); Create `apps/ui/src/components/views/board-view/groups-panel.tsx` (list groups: name, status badge, per-child chips w/ status colors, start/cancel buttons, child count + progress); Modify `apps/ui/src/lib/http-api-client.ts` (groups API methods + subscribe 'group:event' → store refresh); surface the panel + a "New Group" entry where the board's existing action affordances live (follow board-header / worktree-panel conventions — smallest clean integration, no kanban drag-drop).

- [ ] 5.1 Store + api client methods (+ types from @aboardai/types). Unit tests for store reducers/refresh-on-event.
- [ ] 5.2 Dialog: multi-select of eligible features (backlog/ready, current project), name, baseBranch picker (reuse branch autocomplete conventions from add-feature-dialog), maxConcurrency Slider (1-10, reuse the auto-mode-settings-popover slider pattern), retryLimit (0-5). Validates 2-20 selection client-side.
- [ ] 5.3 Panel renders from store; 'group:event' keeps it live. Typecheck + lint + UI unit tests green; full suite green. OPTIONAL BONUS (only if straightforward): one Playwright spec (mock mode): open dialog → create group from 2 seeded features → panel shows pending group. Commit `[phase4] groups UI (store, dialog, panel, live events)`.

### Task 6: Phase gate — _Sonnet_

- [ ] 6.1 Formal gate: build:packages + lint + full vitest (root; baseline 3,606+) + workspaces tests + build.
- [ ] 6.2 E2E @ --workers=2: ≥70 passed, failures within documented set (+ the new optional group spec if added).
- [ ] 6.3 LIVE PROOF (the Phase 4 equivalent of Phase 3's 84-event smoke): server with ABOARDAI_MOCK_AGENT=true; temp git project; FIRST verify the mock agent path drives a lone feature to a terminal completed-like status (it did in the Phase 3 smoke — result event observed; if mock leaves features non-terminal, adapt the queue's success criterion to the status the mock produces and document it). Then: create 3 features via API (one with a dependency on another); create a group of all 3 (maxConcurrency 2, retryLimit 1); start it; poll GET /api/groups/get until settled. Assert: group status 'review'; all children completed; dependency child ran AFTER its dependency; `.aboardai/groups/{id}/group.json` snapshot matches; `.aboardai/groups/{id}/events.jsonl` contains group_created→…→group_settled. Record the event count.
- [ ] 6.4 Wrap: docs/superpowers/plans/phase4-results.md (commits, gate numbers, live-proof transcript summary); tasks/todo.md Phase 4 section; commit; merge → main (no-ff) `[phase4] task groups complete — gate green`; confirm main HEAD.

---

## Execution notes for the orchestrator

- Sequential 0→1→2→3→4→5→6, EXCEPT Task 2 (worktree mutex) is independent of 1 — may run while Task 1 is reviewed, same-checkout rules permitting (default: sequential).
- Models: all Sonnet (Task 4 may drop to Haiku if route scaffolding proves fully mechanical — orchestrator's call after Task 3).
- Hard rules: NEVER commit tokens (.npmrc = registry line only); Manifest pinned 2.4.1 exact; guard logic lives in taskgroup.manifest unless inexpressible (then wrapper + documented note); existing feature-execution behavior untouched for non-group features; Phase 3 event-log feature-path behavior unchanged (additive generalization only); Windows git-bash; 600000ms timeouts; npx kill-port only.
