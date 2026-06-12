# Phase 5: Polish & v1 Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out AboardAI v1: fix the two remaining deterministic E2E failures, resolve the orphaned-spec question, break the electron↔app-store import cycle, close the `UpdateFeatureStatus` prompt/tool gap by shipping the minimal agent-governed board-mutation tool (A2 stretch, scoped), clean stale docs, fix the one high-priority TODO, and run the final v1 gate including a Windows Electron package build.

**Architecture:** Surgical fixes, no new subsystems. The A2-stretch implementation uses the Agent SDK's in-process custom-tool mechanism (`createSdkMcpServer`/`tool()` from `@anthropic-ai/claude-agent-sdk`, available since 0.3.x per the verified research) to expose `update_feature_status` + `get_feature` backed by the existing FeatureStateManager — agents mutate board state through a validated tool instead of raw file edits. Full Manifest-guarded agent mutations (groups) are DEFERRED to post-v1 roadmap (recorded in results doc).

**Branch:** `phase5-polish` off main (@ 51af9c3). **Spec:** Phase 5 bullet + Amendment A2 stretch + accumulated backlog (tasks/todo.md, phase1-baseline.md).

**Scout-verified facts (2026-06-12):** prompts clean of model-era staleness (48 exports; port warnings rebranded at defaults.ts L255/L368; sentinel instructions intact across 7+ templates); README 670 lines mostly fresh; stale docs = install-fedora.md, prd-to-features-guide.md, settings-api-migration.md, checkout-branch-pr.md; board-background-persistence failing asserts at spec L425-433 with useProjectSettingsLoader at apps/ui/src/hooks/use-project-settings-loader.ts (dataUpdatedAt dedup ref at L37-53); electron.ts↔app-store.ts cycle = type imports (electron.ts:8 ClaudeUsageResponse from app-store) + runtime imports (app-store.ts:3-4 Project/TrashedProject types + saveProjects/saveTrashedProjects fns from electron); DEFAULT_AGENT_SYSTEM_PROMPT L341/L357 references an `UpdateFeatureStatus` tool the scout could not find exposed anywhere; TODO debt: Gemini key verification endpoint (use-api-key-management.ts:159, HIGH), terminal themes + provider-action harmonization (defer); Electron build scripts present, no documented blockers. tests/e2e/multi-project-dashboard.spec.ts: Phase 1 found it orphaned (no runner config covers tests/e2e/), scout now claims "active" without citing a runner — RESOLVE DEFINITIVELY in Task 2. Baselines @ 51af9c3: 3,723 unit tests / 28 skipped; E2E 70/74-ish @ --workers=2 (2 deterministic + documented flakes).

---

### Task 1: Fix board-background-persistence deterministic failures — _Sonnet (systematic debugging)_

**Files:** likely `apps/ui/tests/projects/board-background-persistence.spec.ts` and/or `apps/ui/src/hooks/use-project-settings-loader.ts`.

- [ ] 1.1 Reproduce: run the spec file alone at --workers=1; confirm :41 and :444 fail deterministically. Use superpowers:systematic-debugging — instrument, don't guess. Known hypothesis (Phase 1): the test's `page.on('request')` tracker attaches after `useProjectSettingsLoader` fires, or the test's project-switch simulation (localStorage injection) bypasses the React state change that triggers the hook; the hook's `dataUpdatedAt` dedup ref (L37-53) may also suppress a re-fetch the test expects.
- [ ] 1.2 Fix the ROOT CAUSE: if the product hook is correct and the test races, fix the test (attach listeners before navigation / drive the switch through real UI affordances); if the hook genuinely misses a load on project switch (a real user-facing bug), fix the hook. State clearly which it was.
- [ ] 1.3 Spec file green 3 consecutive runs; full UI unit tests + affected E2E neighbors green. Commit `[fix] board-background-persistence deterministic failures (root cause: ...)`.

### Task 2: Resolve tests/e2e/multi-project-dashboard.spec.ts — _Haiku_

- [ ] 2.1 Determine definitively: does ANY runner execute it (grep playwright configs/testDir/projects + package.json scripts + CI workflows)? Run `npx playwright test ../../tests/e2e/multi-project-dashboard.spec.ts --list` style checks from apps/ui to see if it's reachable.
- [ ] 2.2 If orphaned: either wire it into apps/ui/playwright.config.ts (add testDir entry or move the file next to its peers under apps/ui/tests/) IF it passes once wired and adds value, OR delete it with a one-line note in the results doc. Prefer wiring+keeping if it passes within ~20min of effort; else delete (it tests overview navigation already covered elsewhere — check for overlap before deciding).
- [ ] 2.3 Full E2E list count updated in results notes. Commit `[fix|chore] multi-project-dashboard spec wired|removed`.

### Task 3: Break the electron.ts ↔ app-store.ts cycle — _Sonnet_

**Files:** `apps/ui/src/lib/electron.ts`, `apps/ui/src/store/app-store.ts`, likely a new `apps/ui/src/types/` or existing types module for the shared shapes.

- [ ] 3.1 Map the full cycle set first (madge or tsc trace or manual: the Phase-1 graph found 6 cycles, all through electron.ts↔app-store.ts and the file-browser chain — fix ONLY the electron↔app-store family this phase). Move the shared TYPES (`ClaudeUsageResponse` & friends used by electron.ts; `Project`/`TrashedProject` used by app-store) into a standalone types module imported by both. The runtime imports (`saveProjects`/`saveTrashedProjects` in app-store) need an honest direction decision: persistence helpers belong BELOW the store — move them (or re-export from a non-cycling module) so app-store imports persistence without persistence importing app-store.
- [ ] 3.2 Verify: no behavior change (typecheck, full UI unit tests, lint); cycle gone (madge --circular or equivalent check on the two files; record before/after cycle count for the family).
- [ ] 3.3 Commit `[refactor] break electron<->app-store import cycle (shared types extracted)`.

### Task 4: A2 stretch (scoped) — agent board-mutation tool + prompt truth — _Sonnet, TDD_

**Files:** Create `apps/server/src/lib/agent-tools.ts` (SDK custom tools); Modify `apps/server/src/lib/sdk-options.ts` (wire into auto-mode/chat option builders), `libs/prompts/src/defaults.ts` (only if tool naming changes); Tests.

- [ ] 4.1 VERIFY the gap first: confirm `UpdateFeatureStatus` is not currently provided to agents (grep sdk-options/agent-executor/claude-provider for it; check whether the SDK's allowedTools list including a non-existent name is harmless). Report the truth before building.
- [ ] 4.2 Implement via the Agent SDK's in-process tool mechanism (verify exact API in installed 0.3.173 .d.ts: `createSdkMcpServer` + `tool()` with zod schemas per docs/superpowers/research/claude-agent-sdk-2026.md): an `aboardai` SDK MCP server exposing `update_feature_status` (featureId, status — validated against the legal status set; writes via FeatureStateManager so persist-before-emit + WS events fire) and `get_feature` (featureId → snapshot). Wire into createAutoModeOptions/createChatOptions sdkOptions (mcpServers + allowedTools entries). SCOPE GUARD: feature status + read only — NO group commands, NO deletes (deferred to roadmap).
- [ ] 4.3 Align DEFAULT_AGENT_SYSTEM_PROMPT tool list with reality (exact tool names agents will see, e.g. `mcp__aboardai__update_feature_status` — verify the SDK's MCP tool-name prefixing convention and use the real name).
- [ ] 4.4 Tests: unit-test the tool handlers (status validation, unknown feature, success path calls FeatureStateManager); one executor-level test proving the tool reaches a mock agent's allowedTools/mcpServers. Full suite green. Commit `[phase5] agent board-mutation tool (update_feature_status) — closes prompt/tool gap (A2 scoped)`.

### Task 5: Docs cleanup + Gemini TODO — _Haiku_

- [ ] 5.1 Delete `docs/install-fedora.md`, `docs/prd-to-features-guide.md`, `docs/settings-api-migration.md`, `docs/checkout-branch-pr.md` (verify nothing links to them: grep docs/ README app sources for references; fix links). README: remove/adjust anything referencing deleted docs; confirm the June-2026 billing note still reads correctly; add a short "Task Groups" feature bullet (it shipped in Phase 4 and the README features list predates it) + one line for the new agent board-mutation tool.
- [ ] 5.2 Gemini key verification TODO (use-api-key-management.ts:159): check what verification endpoints exist for other providers (claude/codex auth routes from the provider-status family) and add the matching minimal `/api/auth/gemini/verify`-style endpoint + wire the UI call (follow the existing pattern EXACTLY; if no comparable pattern exists for any provider, downgrade to documenting the TODO in the roadmap instead — report which).
- [ ] 5.3 Record deferred roadmap items in docs/superpowers/plans/phase5-results.md draft: terminal themes, provider-action harmonization, full Manifest-guarded agent group mutations, remaining file-browser import cycles, SQLite repository pattern (spec roadmap), diff-review + PR flow (spec non-goals). Commit `[docs] stale docs removed, README current, gemini verify endpoint|roadmap`.

### Task 6: v1 final gate — _Sonnet_

- [ ] 6.1 Formal gate: build:packages + lint + full root vitest (≥3,723 + additions) + workspaces + build.
- [ ] 6.2 FULL E2E pass @ --workers=2: target ZERO deterministic failures (Task 1 fixed the last two; flakes classified per baseline doc; re-run flakes once). Record final counts — this is the spec's "inherit and keep green" closing number.
- [ ] 6.3 Electron Windows package: `npm run build:electron:win` (600000ms; this produces an NSIS installer under apps/ui/release/) — record success + artifact name/size. Best-effort: if signing/packaging fails for environment reasons, record exact error as a known issue (non-blocking for v1 dev usage; dev:electron already proven).
- [ ] 6.4 Live smoke: dev:server + health + one mock feature run (events.jsonl sanity) + one mock 2-feature group to review (Phase 4 recipe; C:/Temp paths on Windows).
- [ ] 6.5 Wrap: finalize phase5-results.md (incl. v1 CLOSING SUMMARY: spec goals 1-6 status table); tasks/todo.md Phase 5 section + v1 review; update spec Status line to "v1 delivered — <date>"; merge → main (no-ff) `[phase5] polish complete — AboardAI v1 gate green`; confirm HEAD.

---

## Execution notes for the orchestrator

- Order: 1 → 2 → 3 → 4 → 5 → 6. Tasks 2 and 5 are independent of 1/3/4 but same-checkout: sequential by default; 2 may slot anywhere.
- Models: Tasks 1, 3, 4, 6 Sonnet; 2, 5 Haiku.
- Hard rules: no new subsystems; sentinel formats untouched; group/event/supervisor modules untouched except via their public APIs; Windows git-bash; 600000ms timeouts; npx kill-port only; C:/Temp for temp projects (git-bash /tmp ≠ Node tmp).
