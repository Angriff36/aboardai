# Phase 5: Polish & v1 Gate — Results & Roadmap

**Status:** Phase 5 implementation (Tasks 1-6 in progress)  
**Baseline:** 3,723 unit tests, 70/74 E2E tests  
**Branch:** `phase5-polish`

---

## v1 Spec Goals — Status Table

| Goal                                                            | Status   | Notes                                           |
| --------------------------------------------------------------- | -------- | ----------------------------------------------- |
| Fix board-background-persistence deterministic E2E failures     | [Task 1] |                                                 |
| Resolve tests/e2e/multi-project-dashboard.spec.ts orphaned spec | [Task 2] |                                                 |
| Break electron↔app-store import cycle                           | [Task 3] | Shared types extracted                          |
| Agent board-mutation tool (A2 stretch, scoped)                  | [Task 4] | `update_feature_status` via SDK MCP             |
| Clean stale docs, fix Gemini verification TODO                  | [Task 5] | 4 docs deleted, README current, Gemini deferred |
| v1 final gate (build, tests, smoke, Windows Electron pkg)       | [Task 6] |                                                 |

---

## Task 5: Docs Cleanup + Gemini TODO

### Completed

- **Stale docs deleted:** 4 files removed with no inbound references found
  - `docs/install-fedora.md`
  - `docs/prd-to-features-guide.md`
  - `docs/settings-api-migration.md`
  - `docs/checkout-branch-pr.md`

- **README.md updated:**
  - Added Task Groups feature bullet (Phase 4 shipped): "Group features for concurrent execution with configurable concurrency limits, per-child retry, and auto-advance to review"
  - Added Agent Board Tool feature bullet: "Agents can update feature status through a validated tool, enabling autonomous board state mutations"
  - Model references (Opus, Sonnet, Haiku) remain generic/current; no falsehoods detected

### Deferred to Post-v1 Roadmap

- **Gemini key verification endpoint** — Route `/api/setup/verify-gemini-auth` not implemented
  - **Reason:** Gemini uses CLI tool (`@google/gemini-cli`), not a queryable SDK like Claude Agent SDK. Comparable verification pattern (run test query via SDK) does not exist for Gemini in this codebase.
  - **Current state:** UI accepts Gemini keys with message "Connection test not yet available" (line 178 in use-api-key-management.ts). This is acceptable for v1.
  - **Post-v1:** Add verification via Gemini CLI if available (`gemini --version` + credential check), or explore REST API for key validation.

- **Terminal theme variants** (solarized-light, github-dedicated themes) — Design & implementation deferred
  - **Reason:** 25+ themes already shipped; solarization is low-priority UX polish. Can be added incrementally.

- **Provider-action-type harmonization** (state-types.ts:632) — Schema refactoring deferred
  - **Reason:** Cross-provider action type standardization spans multiple codepaths (Claude, Codex, Gemini, OpenCode, Copilot). Requires audit of agent outputs for each provider; out of scope for v1 polish.
  - **Post-v1:** Establish canonical ProviderAction enum and normalize all providers.

- **Manifest-guarded agent group mutations (A2 full stretch)** — Full scope deferred to Phase 6+
  - **Reason:** Phase 5 A2 scope is minimal (`update_feature_status` + `get_feature` only). Full group state mutations (create, delete, modify) require Manifest validation layer. Documented separately in Task 4 results.
  - **Post-v1:** Extend agent-tools.ts with `create_task_group`, `delete_task_group`, etc. with Manifest guards.

- **File-browser import-cycle cleanup** — ~35 cycles remain after electron/app-store fix
  - **Reason:** Remaining cycles span file-browser context (uses store, provides UI), electron (file API), and several shell-script utilities. Requires careful re-architecture; Task 3 addresses only the highest-impact cycle.
  - **Post-v1:** Audit remaining cycle sources and refactor component boundaries.

- **SQLite repository pattern** (spec non-goal, roadmap item) — Schema + migration design deferred
  - **Reason:** Current file-based storage works for v1. SQLite would improve query/analysis performance but is major architectural change. Left for post-v1 scale phase.
  - **Post-v1:** Evaluate SQLite adoption for feature/context query optimization.

- **Diff-review + one-click PR flow** (spec non-goal) — UX + backend deferred
  - **Reason:** Worktree diff review available via git diff view; auto-PR requires GitHub integration beyond current scope. Useful but not blocking v1.
  - **Post-v1:** Wire worktree-create-pr endpoint to UI as one-action PR flow.

- **Chat-session wiring for aboardai agent tools** — projectPath assembly deferred
  - **Reason:** Agent sessions (Agent view in sidebar) are currently independent chat with agents. Wiring them to board/context requires `projectPath` context passing through session state. Minor integration but not critical for v1.
  - **Post-v1:** Pass projectPath to agent sessions so tools reference active project.

---

## Test Baselines

### Unit Tests

- **Before:** 3,723 (28 skipped)
- **After:** [Pending — no new tests added; count unchanged or +1 if route tests added per Task 4]

### E2E Tests

- **Before:** 70/74 passing (2 deterministic failures, 2 flakes)
- **After:** [Pending — Task 1 fixes deterministic, Task 2 resolves multi-project spec]

---

## Known Issues / Open Questions

- Task 1: Does the test race (attach listener too late) or is the hook missing a load on project switch?
- Task 2: Is multi-project-dashboard.spec.ts valuable enough to wire in, or should it be deleted as redundant?
- Task 3: After electron↔app-store cycle break, do remaining 35 file-browser cycles become isolated or cascade?
