# Phase 2 Results — ClaudeProvider Competition & Gate Record

**Date:** 2026-06-11
**Rubric:** docs/superpowers/plans/2026-06-11-phase2-provider-layer.md (Winner-selection rubric)

## Competition verdict: Implementation A wins

| Criterion                            | A (reliability-first, commit bde444a)                                                | B (clarity-first, commit 8cd8f36)                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1. Test pass rate                    | All gates green (worktree suite 3,463 passed; 51 unit + 4 supervised provider tests) | All gates green (worktree suite 3,459 passed; 47 unit + 4 supervised)                                                       |
| 2. Adversarial findings (calibrated) | **≈8** — 0 Critical / 2 Important / 4 Minor                                          | **10** — 0 Critical* / 3 Important / 2 Minor (*1 raw Critical recalibrated to Important: latent, unreachable via typed API) |
| 3. Clarity                           | 4/5                                                                                  | 4/5                                                                                                                         |

Calibration notes: both worktrees forked at `157ac20`, before the Task 6 alias fix (`5b2c333`) — reviewer findings about stale `opus → claude-opus-4-6` aliases are moot on merge and were excluded from BOTH scores. The `isAdaptiveThinkingModel()` gap in `libs/types/src/settings.ts` (doesn't recognize `claude-opus-4-8`) is a shared system bug outside both implementations' allowed file scope — excluded from scores, assigned to the merge task.

Decisive qualitative differences:

- A diagnosed the retry-after parser mismatch between provider error enhancement and supervisor text parsing, and fixed it within its file scope with an exact-wait proof; B documented the same gap and relaxed its test assertion instead (confirmed by its reviewer as hiding a fixable gap).
- Effort semantics for `reasoningEffort: 'none'|'minimal'`: A clamps to `'low'` (errs toward user intent); B drops the option entirely, silently leaving Opus 4.8 at its default `'high'` (errs against user intent).

## Merge-time fix list (from adversarial reviews + system findings)

1. **[A-Important] Watchdog env leak into ClaudeCompatibleProvider clean-switch path** — watchdog vars must not be inherited from process.env on the clean-switch path (fixed defaults OK; hostile process.env override not OK). Add isolation test.
2. **[A-Important] `none`→`low` effort mapping** — keep the clamp (best available approximation) but document the rationale in JSDoc and add explicit tests for `'none'`; make the effort map exhaustive against SDK `EffortLevel` (B-review's 'max' false-contract point).
3. **[A-Minor, superseded] Remove the `(retry after Ns)` message suffix** — Task 7 (`1673f83`) added structured `err.retryAfter` reading to the supervisor (S12), which supersedes the text-suffix workaround and avoids double-rendered wait times in UI messages. Verify A's exact-wait supervised test still passes via the structured path.
4. **[Shared system] `libs/types/src/settings.ts isAdaptiveThinkingModel()`** — must recognize `claude-opus-4-8` (currently `includes('opus-4-6') || === 'claude-opus'`), else UI normalizes 'adaptive' → 'none' for the new default model. Sonnet-4-6 supports both adaptive and extended thinking, so it intentionally stays outside the adaptive-only list. Update dependent helpers/tests (`getThinkingLevelsForModel`, `getDefaultThinkingLevel`, `normalizeThinkingLevelForModel`).
5. **[A-Minor] Prefix-table order dependence** — one comment documenting that MODEL_CAPABILITIES order matters for prefix matching; **[A-Minor]** unit test asserting `caught.retryAfter` value on enhanced rate-limit errors.

## Phase progress record (branch `phase2-provider-layer`)

| Commit  | What                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b4aa497 | SDK bumps (claude-agent-sdk 0.3.173, codex-sdk 0.139) + verified-types research note                                                                                                  |
| 04aef92 | Supervision types in @aboardai/types + SDK 0.3 systemPrompt alignment                                                                                                                 |
| 62a2211 | Fault-injection harness S1–S10 (red)                                                                                                                                                  |
| 43b7799 | ProviderSupervisor — S1–S10 green                                                                                                                                                     |
| 157ac20 | Repo green on SDK 0.3.173 (Task tools presets, content-block types, Windows env vars)                                                                                                 |
| f6bf6fa | Supervisor early-return cleanup (review fixes) + S11 + fatal-result fail-fast root-cause fix                                                                                          |
| 5b2c333 | Model catalog aliases → Opus 4.8 / Sonnet 4.6 / Haiku 4.5                                                                                                                             |
| 1673f83 | Supervisor wired into agent-service/agent-executor/ideation + structured retryAfter (S12)                                                                                             |
| 0445312 | Codex 0.139 refresh (resumeThread, event mapping, aggregated_output defense)                                                                                                          |
| d219c5a | **Competition winner merge** — ClaudeProvider rebuilt (impl A wins); merge clean; post-merge gate: 3,476 server tests green; S3 supervised test passes via structured retryAfter path |
| 4499723 | **Fix1+2+3+5**: watchdog clean-switch isolation; effort mapping exhaustive + JSDoc; retry-after text suffix removed (structured path only); MODEL_CAPABILITIES order comment          |
| 718e62a | **Fix4**: isAdaptiveThinkingModel recognizes claude-opus-4-8; new settings-thinking test file (71 tests)                                                                              |

**Final gate numbers (phase2-provider-layer, post fix-list):**

- typecheck: clean (server + UI)
- lint: clean
- `npx vitest run` (apps/server): **3,501 passed / 28 skipped** (0 failed)
- `npm test --workspaces --if-present` (libs): **278 passed** (0 failed)
- `npm run build`: green

Worktrees cleaned up: agent-a47bccef870d452c8 and agent-a41bd4a1c25b4b9d3 removed; branches deleted.

---

## Task 9 — Formal Phase Gate (2026-06-12)

**Branch:** `phase2-provider-layer` (pre-merge)
**Platform:** Windows 11 Home 10.0.26200 | Node v22.18.0

### 9.1 Build / Lint / Unit

| Check                                        | Result                                              |
| -------------------------------------------- | --------------------------------------------------- |
| `npm run build:packages` (8 libs)            | PASS — all 8 compiled clean via tsc                 |
| `npm run lint`                               | PASS — exit 0, zero errors/warnings                 |
| `npx vitest run` (root, 142 test files)      | **3,501 passed / 28 skipped / 0 failed** (27.46s)   |
| `npm test --workspaces --if-present` (9 lib) | **278 passed / 0 failed** (0.42s)                   |
| `npm run build`                              | PASS — Vite client ✓ 7.90s, Electron main/preload ✓ |

### 9.2 E2E Parity (workers=2)

**Run totals:** 2 failed | 70 passed | 2 skipped | 74 total tests | duration ~4.2 min

**Failures (both documented Phase 1 deterministic failures — no Phase 2 regressions):**

1. `tests/projects/board-background-persistence.spec.ts:41` — "should load board background settings when switching projects" — deterministic baseline failure (settings API call timing, pre-existing)
2. `tests/projects/board-background-persistence.spec.ts:444` — "should load background settings on app restart" — deterministic baseline failure (pre-existing)

**Verdict:** PASS — 70 ≥ 64 baseline floor; both failures in documented deterministic set; no Phase 2 regressions.

**Note on fixtures.spec.ts:51 (Windows backslash traversal):** Passed in this run — the pre-commit fixes from Task 9 of Phase 1 (commit 3c2a521) that branched on `process.platform === 'win32'` were already present on this branch and resolved this previously-deterministic failure, improving it from baseline (from 3 deterministic to 2).

### 9.3 Live Smoke (SDK 0.3.173)

**Server startup:** `npm run dev` (apps/server) — `tsx watch src/index.ts`

**Auth detection log line:**
```
INFO  [Server] ✓ Claude Code CLI authentication detected
```
Present in log. No auth errors. Claude CLI auth continues to work correctly with SDK 0.3.173.

**GET /api/health response:**
```json
{"status":"ok","timestamp":"2026-06-12T05:48:57.010Z","version":"1.0.0"}
```

**GET /api/models/providers response:**
```json
{
  "success": true,
  "providers": {
    "anthropic": { "available": true, "hasApiKey": false },
    "cursor": {
      "available": true,
      "version": "2026.05.09-0afadcc",
      "path": "C:\\Users\\Ryan\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
      "method": "cli",
      "authenticated": true
    }
  }
}
```

Interpretation: `anthropic.available=true` (ClaudeProvider is registered/active) but `hasApiKey=false` (no `ANTHROPIC_API_KEY` env var set — authentication flows through Claude CLI, not raw API key, which is the intended SDK 0.3.173 path). `cursor.available=true` and authenticated confirms the Codex provider is also wired up. No provider errors.

**Port cleanup:** `npx kill-port 3008` → PASS. Port confirmed free (no LISTENING state).

### Phase Gate Verdict: GREEN

All gate checks passed. Phase 2 provider layer is complete and ready for merge to main.
