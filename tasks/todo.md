# AboardAI Phase 1: Fork & Rebrand — Execution Tracker

Plan: `docs/superpowers/plans/2026-06-11-phase1-fork-rebrand.md`
Spec: `docs/superpowers/specs/2026-06-11-aboardai-v1-design.md`
Mode: subagent-driven (orchestrator = Fable, implementers = Haiku/Sonnet per plan's model assignment)

- [x] Task 1: Import automaker source (raw, no rename) — Haiku (commit 9dd5e66, 1589 files, verified)
- [x] Task 2: Baseline proof on Windows (stock, PRE-rename) — Sonnet (install/build green; units 3413 pass/6 pre-existing fail; OFFICIAL E2E baseline 64/74 pass @ workers=2, commits e70dbd8 + 0c4b2da)
- [x] Task 3: Rename brand-named files (git mv) — Haiku (commit 55fcf9d, 6 files)
- [x] Task 4: Content rename sweep (deterministic script) — Haiku (commit 69f3ddf, 706 files, gate clean, verified)
- [x] Task 5: Post-rename reinstall + rebuild + unit tests — Sonnet (commit c41b149, ZERO fixes needed, units identical to baseline)
- [x] Task 6: E2E suite post-rename — Sonnet (run1 7f/65p/2s, run2 4f/68p/2s; zero rename regressions; all failures in known baseline set)
- [x] Task 7: Identity & attribution files — Haiku (commit 61cc50f, LICENSE/NOTICE/CLAUDE.md merge verified)
- [x] Task 8: Dev-run proof on Windows — Sonnet (commit c68f852; server+web green, Electron window opened, only TIME_WAIT race noted)
- [x] Task 9: Phase gate — Sonnet (commits 3c2a521, 4936e7b; all gate checks green; see Review section)

## Review section

### Phase Summary

AboardAI Phase 1 (Fork & Rebrand) is complete. Starting from automaker commit 5888d2e (MIT-licensed), the codebase was imported (Task 1), baselined on Windows (Task 2), brand-file-renamed via `git mv` (Task 3), content-swept with a deterministic rename script across 706 files (Task 4), rebuilt with zero fixes needed (Task 5), E2E-parity-confirmed post-rename (Task 6), attribution files established (Task 7), dev-run proven in server+web+Electron modes (Task 8), and the final phase gate run with all pre-existing issues triaged or fixed (Task 9). The fork is a clean, attributable hard-fork of automaker with all identifiers updated to `aboardai` / `@aboardai/` / `ABOARDAI_`.

### Per-Task Commit List

| Task      | Commit                     | Description                                              |
| --------- | -------------------------- | -------------------------------------------------------- |
| 1         | 9dd5e66                    | Import automaker source (raw, 1589 files)                |
| 2         | e70dbd8, 0c4b2da           | Baseline proof — install/build/test/E2E                  |
| 3         | 55fcf9d                    | Rename brand-named files via git mv (6 files)            |
| 4         | 69f3ddf                    | Content rename sweep (706 files, script-driven)          |
| 5         | c41b149                    | Post-rename reinstall + rebuild + unit tests             |
| 6         | (E2E run, no code changes) | E2E parity confirmed (65–68 pass, zero regressions)      |
| 7         | 61cc50f                    | Identity & attribution (LICENSE/NOTICE/CLAUDE.md)        |
| 8         | c68f852                    | Dev-run proof (server+web green, Electron window opened) |
| 9 (fixes) | 3c2a521                    | Husky pre-commit + 6 Windows unit/E2E test fixes         |
| 9 (fixes) | 4936e7b                    | TS2322 typecheck fix in board-view.tsx                   |
| 9 (gate)  | (this commit)              | Phase gate wrap-up                                       |

### Final Gate Numbers

| Gate                                                | Result                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Lint (`npm run lint --workspace=apps/ui`)           | PASS (exit 0, zero errors/warnings)                                                                                                   |
| Typecheck (`npm run typecheck --workspace=apps/ui`) | PASS (exit 0, zero errors after fix)                                                                                                  |
| Unit tests (`npx vitest run`)                       | PASS — 3419 passed / 28 skipped / 0 failed (138 files)                                                                                |
| Build (`npm run build`)                             | PASS — all packages + Vite client (3651 modules) + Electron                                                                           |
| Zero-reference grep (`git grep -iI automaker`)      | PASS — 0 matches (excluding docs/superpowers, tasks, LICENSE, NOTICE, README.md attribution link)                                     |
| Working tree                                        | CLEAN — only apps/server/CLAUDE.md (local CogniLayer artifact) + apps/ui/test/ (E2E fixtures) untracked; nothing modified-uncommitted |

### Part A Fixes Made

1. **Husky pre-commit (FIXED)** — `.husky/pre-commit`: wrapped `nvm.sh` source in `{ ... || true; }` so `sh -e` doesn't abort when nvm exits 3. Verified with a real commit (no `HUSKY=0`). Commit: 3c2a521.
2. **Unit: execution-service.test.ts path separator (FIXED)** — Normalized expected path to forward slashes before assertion; `path.join` produces backslashes on Windows. Commit: 3c2a521.
3. **Unit: list-detached-head.test.ts detached HEAD recovery (FIXED)** — Fixed 5 tests: replaced `const pathStr = String(filePath)` with `String(filePath).replace(/\\/g, '/')` in all `readFile` mocks, and updated `normalizePath` mock to also normalize separators. Commit: 3c2a521.
4. **E2E: fixtures.spec.ts:51 Windows backslash traversal (FIXED)** — Branched test on `process.platform === 'win32'`: on Windows, the guard correctly throws; on Unix it does not. Commit: 3c2a521.
5. **Typecheck: board-view.tsx TS2322 (FIXED)** — `handleAddFeature` requires `branchName: string` (non-optional) but both quick-add handlers were passing `undefined` when `addFeatureUseSelectedWorktreeBranch = false`. Fixed by always passing `selectedWorktreeBranch` (guaranteed string, fallback `'main'`). Commit: 4936e7b.

### Remaining Backlog Items

1. **E2E: board-background-persistence.spec.ts:41 and :444** — Two deterministic failures where the settings API call to `/api/settings/project` is never observed by the test's request tracker. Root-cause hypothesis: the `useProjectSettingsLoader` React hook that makes this call either fires before the test's `page.on('request')` listener is attached, or the hook is not triggered by the test's project-switch simulation (the localStorage injection may bypass the React state change that would normally trigger the hook). Deep integration issue requiring live-app debugging with Playwright inspector. Documented in `docs/superpowers/plans/phase1-baseline.md` under "Deterministic failures". Recommend Phase 5 backlog — investigate `useProjectSettingsLoader` call timing and test hook attachment ordering.

2. **README.md automaker attribution link** — `README.md` contains one reference to `automaker` as the link text for `https://github.com/AutoMaker-Org/automaker` (intentional upstream credit). Excluded from the zero-reference gate via `:!README.md`. The URL itself cannot be changed. No action needed.

---

# AboardAI Phase 2: Provider Layer — Execution Tracker

Plan: `docs/superpowers/plans/2026-06-11-phase2-provider-layer.md`
Results: `docs/superpowers/plans/phase2-results.md`
Branch: `phase2-provider-layer` → merged to `main`

- [x] Task 0: SDK bumps (claude-agent-sdk 0.3.173, codex-sdk 0.139) — commit b4aa497
- [x] Task 1: Supervision types in @aboardai/types + SDK 0.3 systemPrompt alignment — commit 04aef92
- [x] Task 2: Fault-injection harness S1–S10 (red) — commit 62a2211
- [x] Task 3: ProviderSupervisor — S1–S10 green — commit 43b7799
- [x] Task 4: Repo green on SDK 0.3.173 (Task tools presets, content-block types, Windows env vars) — commit 157ac20
- [x] Task 5: Supervisor early-return cleanup + S11 + fatal-result fail-fast root-cause fix — commit f6bf6fa
- [x] Task 6: Model catalog aliases → Opus 4.8 / Sonnet 4.6 / Haiku 4.5 — commit 5b2c333
- [x] Task 7: Supervisor wired into agent-service/agent-executor/ideation + structured retryAfter (S12) — commit 1673f83
- [x] Task 8: Codex 0.139 refresh (resumeThread, event mapping, aggregated_output defense) — commit 0445312
- [x] Task 9 (gate): Phase gate — formal build/lint/test/E2E/smoke — commits 3d6a10d + (gate record commit)

## Phase 2 Review

AboardAI Phase 2 (Provider Layer) is complete. The ClaudeProvider was rebuilt around SDK 0.3.173 with a ProviderSupervisor fault-injection harness (S1–S12), model catalog updated to Opus 4.8 / Sonnet 4.6 / Haiku 4.5, structured retryAfter error handling, and the isAdaptiveThinkingModel fix for claude-opus-4-8. A two-implementation competition selected the reliability-first design (impl A). All merge-time fix-list items were resolved. Phase gate: typecheck/lint/build clean; 3,501 server tests + 278 lib tests passing; E2E 70 passed / 2 failed / 2 skipped (both failures are documented Phase 1 deterministic failures, none introduced by Phase 2); server smoke confirmed `✓ Claude Code CLI authentication detected` with SDK 0.3.173. Branch merged to main at HEAD 5baf12d → new HEAD (see git log).

### Phase 2 Final Gate Numbers

| Gate                                          | Result                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run build:packages`                      | PASS — all 8 libs compiled clean                                                 |
| `npm run lint`                                | PASS — exit 0, zero errors/warnings                                              |
| `npx vitest run` (root, all workspaces)       | PASS — 3,501 passed / 28 skipped / 0 failed (142 files)                          |
| `npm test --workspaces --if-present` (libs)   | PASS — 278 passed / 0 failed (9 files)                                           |
| `npm run build`                               | PASS — Vite client (3651+ modules) + Electron clean                              |
| E2E `--workers=2`                             | PASS — 70 passed / 2 failed / 2 skipped (both failures = baseline deterministic) |
| Server smoke (`/api/health`)                  | PASS — HTTP 200; `✓ Claude Code CLI authentication detected`                     |
| `GET /api/models/providers`                   | PASS — anthropic available (no env key), cursor cli available+authenticated      |
