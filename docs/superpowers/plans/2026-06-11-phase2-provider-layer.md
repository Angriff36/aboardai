# Phase 2: Provider Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the provider layer's reliability: upgrade the Claude Agent SDK across two breaking-change boundaries, add a generic stream supervisor (stall detection → classified retry → session resume) proven by a fault-injection harness, rebuild ClaudeProvider via competing implementations, refresh CodexProvider, and bring the model catalog current — all WITHOUT changing the consumer-facing contract.

**Architecture:** The scouts confirmed consumers (agent-service.ts, agent-executor.ts, ideation-service.ts, recovery-service.ts) depend only on `executeQuery(ExecuteOptions): AsyncGenerator<ProviderMessage>` plus the ProviderMessage shape and downstream sentinel parsing. Therefore: the `BaseProvider` contract is **kept** (it already has the spec's four capabilities under automaker names: executeQuery / detectInstallation / getAvailableModels / `resume` via `options.sdkSessionId`). The new reliability layer is a `ProviderSupervisor` that _wraps_ any provider's stream and re-exposes the identical AsyncGenerator interface, so consumer call sites change by one wrapper call, not by re-plumbing.

**Tech Stack:** TypeScript, Vitest (unit), apps/server workspace. `@anthropic-ai/claude-agent-sdk` 0.2.32→0.3.173 (breaking: 0.2.113 env replacement; 0.3.142 TodoWrite removal, MCP non-blocking, unstable session API removal). `@openai/codex-sdk` ^0.98.0→^0.139.0.

**Branch:** `phase2-provider-layer` off `main` (created in Task 0). Merge to main only at the phase gate.

**Spec:** `docs/superpowers/specs/2026-06-11-aboardai-v1-design.md` (Component 1 + Amendment A1)
**Research:** `docs/superpowers/research/claude-agent-sdk-2026.md`, `docs/superpowers/research/codex-sdk-2026.md`
**Scout findings (2026-06-11, do not re-derive):** see "Established facts" below.

---

## Established facts

- `BaseProvider` (apps/server/src/providers/base-provider.ts, 95 LOC): abstract `getName()`, `executeQuery(options): AsyncGenerator<ProviderMessage>`, `detectInstallation(): Promise<InstallationStatus>`, `getAvailableModels(): ModelDefinition[]`.
- ClaudeProvider (claude-provider.ts, 449 LOC) already passes `resume: sdkSessionId` to the SDK (L239-241); consumers persist/pass `sdkSessionId` (agent-service.ts L561, L596-600; sessions-metadata.json field). Stale-session errors clear the id (agent-service.ts L105-113).
- `buildEnv()` (claude-provider.ts L74-178) constructs an explicit env object — compatible with the 0.2.113 env-replacement semantics, but must be VERIFIED to include Windows vars (APPDATA, LOCALAPPDATA, USERPROFILE, TEMP, SystemRoot).
- TOOL_PRESETS (apps/server/src/lib/sdk-options.ts L124-164) contain `TodoWrite` in `fullAccess` and `chat` — removed in SDK 0.3.142; replace with `TaskCreate`,`TaskUpdate`,`TaskGet`,`TaskList`.
- error-handler.ts (416 LOC) has `classifyError()` regex categories (AUTH/BILLING/RATE_LIMIT/NETWORK/TIMEOUT/…) and `createRetryHandler()` (expo backoff + jitter) but NOTHING wires retry/reconnect into streaming. There is no stall detection anywhere.
- ProviderFactory (provider-factory.ts, 351 LOC): priority registry with `canHandleModel`; `ABOARDAI_MOCK_AGENT=true` short-circuits to MockProvider (mock-provider.ts, 54 LOC).
- Model catalog is stale: ClaudeProvider lists claude-opus-4-6 (default), claude-sonnet-4-6, claude-sonnet-4-20250514, claude-3-5-sonnet-20241022, claude-haiku-4-5-20251001. `DEFAULT_MODELS.claude = 'claude-opus-4-6'` in @aboardai/model-resolver.
- Consumers' stream loop: agent-service.ts L589-765 (assistant/tool_use/tool_result/result/error handling, session_id capture); agent-executor.ts L488-576 (sentinel parsing via spec-parser.ts: `[TASK_START] T###`, `[TASK_COMPLETE] T###`, `[PHASE_COMPLETE]`, `[SPEC_GENERATED]`, `<summary>`).
- Existing provider unit tests: tests/unit/providers/\*.test.ts (base 239 lines, claude 380+, factory 400+, codex 450+, copilot 550+, opencode 1200+ …). All green at Phase 1 gate (3,419 passed).
- Current versions installed: claude-agent-sdk 0.2.32 (root hoisted), codex-sdk 0.98.0.
- SDK 0.3.173 key capabilities (research doc): `session_id` available from init SystemMessage; result subtypes incl. `api_error_status`; `SDKRateLimitEvent` (fields UNCONFIRMED — verify from package .d.ts after install); watchdog env vars `CLAUDE_ENABLE_STREAM_WATCHDOG` / `CLAUDE_STREAM_IDLE_TIMEOUT_MS`; `startup()` pre-warm; trailing messages can arrive after the result message.
- Husky pre-commit works (fixed in Phase 1). E2E baseline: 64/74 @ `--workers=2` (docs/superpowers/plans/phase1-baseline.md).

## Fault-injection harness scenarios (normative)

The harness lives in `apps/server/tests/unit/supervisor/` and is built BEFORE the supervisor (Task 2) — it is the spec. `FakeProvider extends BaseProvider` executes a declarative script of stream directives:

```typescript
type FakeDirective =
  | { kind: 'message'; message: ProviderMessage; delayMs?: number } // normal streamed msg
  | { kind: 'stall'; ms: number } // emit nothing for ms
  | { kind: 'throw'; error: Error } // stream throws mid-flight
  | { kind: 'end' }; // generator returns

interface FakeRun {
  directives: FakeDirective[];
}
// FakeProvider takes FakeRun[] — run N answers the Nth executeQuery() call,
// so resume-after-failure is scripted as run[0]=failure, run[1]=continuation.
// It records every ExecuteOptions it receives (esp. sdkSessionId) for assertions.
```

Scenarios (each is a named Vitest test the supervisor MUST pass; timing uses fake timers):

| #   | Scenario                          | Script                                                                        | Required supervisor behavior                                                                                                                                                     |
| --- | --------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Stall mid-stream                  | msgs(2 incl. init w/ session_id) → stall(> stallTimeoutMs)                    | abort run; re-invoke with `sdkSessionId` from init msg; splice continuation msgs into SAME consumer stream; emit `status:'stalled'` then `status:'resumed'`                      |
| S2  | Network disconnect                | msgs(2) → throw(ECONNRESET-like)                                              | classify NETWORK → backoff(attempt 1) → resume w/ session id; emit `status:'reconnecting'`                                                                                       |
| S3  | Rate limit                        | msgs(1) → throw(429/rate-limit msg w/ retry-after 7s)                         | classify RATE_LIMIT → wait ≥ retry-after (fake timers) → resume; emit `status:'rate_limited'` with retryAfterMs                                                                  |
| S4  | Auth failure                      | msgs(1) → throw(401/invalid api key)                                          | classify AUTH → NO retry → rethrow enhanced error; emit `status:'fatal'` with type AUTH                                                                                          |
| S5  | Mid-stream crash, resume succeeds | run0: msgs(3) → throw(generic 5xx); run1: msgs(2) → result                    | classify SERVER → backoff → resume; final consumer sees run0 msgs + run1 msgs + result, in order, no duplicates                                                                  |
| S6  | Exhausted retries                 | run0..runN all throw NETWORK (N = maxAttempts)                                | after maxAttempts: throw `SupervisorExhaustedError` carrying classification + attempts; emit `status:'interrupted'` (NOT 'fatal') — consumer marks feature interrupted/resumable |
| S7  | Stale session on resume           | run0: msgs+throw(NETWORK); run1: throw("session not found"); run2: fresh msgs | on stale-session error: clear session id, retry WITHOUT resume (fresh), still within attempt budget                                                                              |
| S8  | Abort respected                   | msgs(1) → stall(long); consumer aborts via AbortController during stall       | supervisor stops promptly, does NOT retry after abort, propagates abort cleanly                                                                                                  |
| S9  | Happy path untouched              | msgs(4) → result → end                                                        | zero supervisor interference: identical messages out, no status events except optional 'started', session id captured                                                            |
| S10 | Result-subtype error (no throw)   | msgs → result{subtype:'error_during_execution', api_error_status:529}         | classified from result message (not exception); 529 = unknown 5xx → SERVER/retryable (NOT rate-limit — no special case for 529); resume                                          |

Supervisor status events are emitted as synthetic ProviderMessages `{ type: 'supervisor_status', status, detail }` interleaved in the stream AND via an optional callback — consumers may ignore them (S9 proves pass-through compatibility), the UI wiring uses them in Task 7.

## Winner-selection rubric (normative, applied in Task 5)

Two implementations (`A`, `B`) of the rebuilt ClaudeProvider are produced in isolated worktrees by Opus agents. Ranked criteria — earlier criterion wins ties only:

1. **Test pass rate**: harness scenarios S1–S10 run against the real ClaudeProvider wired to FakeSdk (a mock of `query()` — see Task 5), plus existing `claude-provider.test.ts` suite (updated for 0.3.173), plus typecheck/lint. Hard gate: any failing test disqualifies unless both fail equally.
2. **Adversarial review findings**: one reviewer agent per implementation, prompted to BREAK it (env handling on Windows, trailing-messages-after-result handling, session id capture before first failure, abort during backoff sleep, double-iteration of generators). Findings weighted Critical=5/Important=2/Minor=1; lower score wins.
3. **Code clarity**: smaller diff, fewer new concepts, comments only where constraints demand. Judged by the same reviewers (1–5 scale, averaged).

The losing implementation's superior fragments MAY be grafted by the merge agent if cited in a review finding.

---

### Task 0: Branch + SDK upgrade groundwork — _Sonnet_

**Files:** Modify `apps/server/package.json`, root `package-lock.json`.

- [ ] 0.1 `git checkout -b phase2-provider-layer` (from main, clean tree).
- [ ] 0.2 In apps/server/package.json set `"@anthropic-ai/claude-agent-sdk": "0.3.173"` and `"@openai/codex-sdk": "^0.139.0"`. Run `npm install` (root, 600000ms).
- [ ] 0.3 `npx tsc --noEmit -p apps/server` (or the workspace's typecheck script) — CAPTURE all compile errors into the report; fix NOTHING yet except trivially-mechanical type renames that block compilation entirely. Expected breakage sites: sdk-options.ts TOOL_PRESETS (TodoWrite), claude-provider.ts SDK option/message types, any import of removed unstable session APIs.
- [ ] 0.4 Inspect installed `node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts`: record EXACT shape of (a) rate-limit stream event type + fields, (b) result message subtypes + `api_error_status`, (c) init system message session_id field, (d) watchdog env var names if typed. Write findings to `docs/superpowers/research/sdk-0.3-types-verified.md` (this resolves the UNCONFIRMED items).
- [ ] 0.5 Commit `[phase2] SDK bumps + compile-break inventory` (package files + research note; code may be temporarily red — that is acceptable on the branch, NOT acceptable past Task 4).

### Task 1: Types for supervision — _Haiku_

**Files:** Modify `libs/types/src/` (provider types module), `libs/types/tests/`.

- [ ] 1.1 Add to @aboardai/types: `SupervisorStatusMessage { type:'supervisor_status'; status:'started'|'stalled'|'reconnecting'|'resumed'|'rate_limited'|'interrupted'|'fatal'; detail?:string; attempt?:number; retryAfterMs?:number }`, widen `ProviderMessage` union to include it; `SupervisorPolicy { stallTimeoutMs:number; maxAttempts:number; baseDelayMs:number; maxDelayMs:number }` with exported `DEFAULT_SUPERVISOR_POLICY = { stallTimeoutMs: 120_000, maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 60_000 }`; `SupervisorExhaustedError` — MUST be a `class SupervisorExhaustedError extends Error` (it is thrown) carrying `{ classification, attempts, lastError }`.
- [ ] 1.2 Unit test: type-level + DEFAULT_SUPERVISOR_POLICY values; `npm test -w @aboardai/types` green.
- [ ] 1.3 Commit `[phase2] supervision types in @aboardai/types`.

### Task 2: Fault-injection harness (FakeProvider + S1–S10 specs) — _Sonnet_

**Files:** Create `apps/server/tests/unit/supervisor/fake-provider.ts`, `apps/server/tests/unit/supervisor/supervisor.scenarios.test.ts`.

- [ ] 2.1 Implement FakeProvider per the directive schema above (extends BaseProvider; multi-run scripting; records received ExecuteOptions per run; supports fake-timer-driven stalls via injectable clock or vi.useFakeTimers-compatible sleeps).
- [ ] 2.2 Write S1–S10 as failing tests importing a not-yet-existing `ProviderSupervisor` from `../../../src/providers/provider-supervisor` (red on purpose). Each test asserts the FULL required behavior column above, including message ordering and no-duplication (S5: assert exact concatenation).
- [ ] 2.3 Verify the suite fails for the right reason (module not found / red assertions), not setup errors. Commit `[phase2] fault-injection harness S1-S10 (red)`.

### Task 3: ProviderSupervisor implementation — _Sonnet_

**Files:** Create `apps/server/src/providers/provider-supervisor.ts`. Modify `apps/server/src/lib/error-handler.ts` (extend, don't rewrite).

- [ ] 3.1 Implement `superviseQuery(provider, options, policy?, onStatus?): AsyncGenerator<ProviderMessage>`: heartbeat timer between yields (stall detection); try/catch around iteration; classification via extended `classifyError` (NEW: add `classifyResultMessage()` — accepts a `ProviderMessage` (result-type), returns `ErrorClassification`; distinct from `classifyError()` which accepts `Error` objects); retry decision per category (AUTH/BILLING/PERMISSION/VALIDATION → fatal; RATE_LIMIT → respect retryAfter, else backoff; NETWORK/TIMEOUT/SERVER → backoff); resume by re-invoking `provider.executeQuery({...options, sdkSessionId: capturedSessionId})`; capture session id from the earliest message bearing one; stale-session handling (clear id, fresh retry); abort signal respected during sleeps (abortable delay); `SupervisorExhaustedError` after maxAttempts with `status:'interrupted'`.
- [ ] 3.2 Make S1–S10 green. NO modifications to scenario assertions — if a scenario seems wrong, STOP and report (orchestrator arbitrates).
- [ ] 3.3 Run full existing unit suite (must stay green — supervisor is additive). Commit `[phase2] ProviderSupervisor — harness S1-S10 green`.

### Task 4: Repo compiles green on SDK 0.3.173 — _Sonnet_

**Files:** Modify `apps/server/src/lib/sdk-options.ts`, `apps/server/src/providers/claude-provider.ts` (minimal mechanical port only — the real rebuild is Task 5), affected tests.

- [ ] 4.1 TOOL_PRESETS: replace `TodoWrite` with `TaskCreate`,`TaskUpdate`,`TaskGet`,`TaskList` in fullAccess + chat. Search the repo for other `TodoWrite` references (prompts lib included — `git grep -l TodoWrite`) and update; prompt-text changes limited to tool-name mentions (full prompt re-tune stays Phase 5).
- [ ] 4.2 claude-provider.ts: mechanical type fixes for 0.3.173 message/option types; verify buildEnv includes `...process.env`-equivalent or the explicit Windows vars (APPDATA, LOCALAPPDATA, USERPROFILE, TEMP, SystemRoot, PATH, HOME); keep behavior otherwise.
- [ ] 4.3 Whole-repo gate: typecheck + lint + `npx vitest run` green (3,419-baseline parity; tests legitimately asserting removed SDK behavior may be updated minimally with a note). Commit `[phase2] repo green on SDK 0.3.173 (mechanical port)`.

### Task 5: ClaudeProvider competition — _2× Opus, isolated worktrees_

**Files (each implementation):** Rewrite `apps/server/src/providers/claude-provider.ts`; update `apps/server/tests/unit/providers/claude-provider.test.ts`; may touch `apps/server/src/lib/sdk-options.ts` thinking/effort logic.

Brief given to BOTH agents (identical):

- [ ] 5.1 Rebuild ClaudeProvider for SDK 0.3.173 best practice per `docs/superpowers/research/claude-agent-sdk-2026.md` + `sdk-0.3-types-verified.md`: capture session_id from init message (not only result); iterate stream to completion (trailing messages after result); surface result-message errors with `api_error_status` attached (so `classifyResultMessage` works); set watchdog env vars from SupervisorPolicy-derived options; auth = API-key-first w/ CLI passthrough (Amendment A1 — preserve existing buildEnv profile logic); model catalog: `claude-opus-4-8` (default), `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (+ keep 2 legacy entries marked deprecated); per-model thinking rules (research doc Q6: adaptive → never set maxThinkingTokens; Haiku → budget allowed); `effort` passthrough for Opus 4.8.
- [ ] 5.2 Tests: update claude-provider.test.ts to assert ALL of the above against a mocked `query()` (FakeSdk pattern — mock the module, not the network). Provider must also pass S1–S10 when wrapped by the supervisor with FakeSdk-driven failures (write a thin adapter test `claude-provider.supervised.test.ts` with at least S1/S3/S5/S7 equivalents at the SDK-mock level).
- [ ] 5.3 Full unit suite + typecheck + lint green in the worktree. Commit in worktree.

Orchestrator then:

- [ ] 5.4 Dispatch one adversarial reviewer (Sonnet) per implementation (see rubric criterion 2 attack list).
- [ ] 5.5 Score per rubric; pick winner; merge winner's worktree branch into `phase2-provider-layer`; graft cited superior fragments from loser if any; delete worktrees. Commit `[phase2] ClaudeProvider rebuilt (competition winner: A|B)`.

### Task 6: Model resolver currency — _Haiku_

**Files:** Modify `libs/model-resolver/src/`, its tests, `apps/server/src/lib/sdk-options.ts` defaults.

- [ ] 6.1 CLAUDE_MODEL_MAP: haiku→`claude-haiku-4-5-20251001`, sonnet→`claude-sonnet-4-6`, opus→`claude-opus-4-8`. DEFAULT_MODELS.claude→`claude-opus-4-8`. Add migration logging for old ids (follow the existing 'opus migration log' pattern found in model-resolver tests).
- [ ] 6.2 Update model-resolver tests to the new map; run `npm test -w @aboardai/model-resolver` + server unit suite (claude-provider catalog tests must agree). Commit `[phase2] model catalog → Opus 4.8 / Sonnet 4.6 / Haiku 4.5`.

### Task 7: Supervisor wiring into consumers — _Sonnet_

**Files:** Modify `apps/server/src/services/agent-service.ts` (~L582), `apps/server/src/services/agent-executor.ts` (L234, L488, L721, L842), `apps/server/src/services/ideation-service.ts` (L252-296).

- [ ] 7.1 Replace direct `provider.executeQuery(options)` with `superviseQuery(provider, options, policyFromSettings, onStatus)` at the listed call sites. `supervisor_status` messages: agent-service emits them as a new `'supervisor'` agent event (UI tolerates unknown event types — verify in apps/ui websocket handler before relying on it; if it would crash, filter to log-only this phase); agent-executor maps `status:'rate_limited'` → emit existing `auto_mode_progress` event with the hint text, `status:'interrupted'` → feature status `interrupted` (NOT failed) preserving current recovery semantics.
- [ ] 7.2 Stale-session clearing in agent-service (L105-113) stays as a backstop but supervisor's S7 behavior is primary.
- [ ] 7.3 Unit tests: extend execution tests to cover one supervised resume path through agent-executor (FakeProvider injected via ProviderFactory mock). Full suite green. Commit `[phase2] supervisor wired into agent-service/agent-executor/ideation`.

### Task 8: Codex refresh + ported-provider compile pass — _Sonnet_

**Files:** Modify `apps/server/src/providers/codex-*.ts`, possibly gemini/copilot/opencode/cursor providers (compile-level only), their tests.

- [ ] 8.1 Codex on ^0.139.0 per `docs/superpowers/research/codex-sdk-2026.md`: `resumeThread(threadId)` honored when `sdkSessionId` provided (SDK path); runStreamed event mapping current (thread/turn/item lifecycle); defend the empty-`aggregated_output` bug (accumulate deltas fallback); error classifier extended with Codex string signals (`rate_limit`/`429`, `unauthorized`/`401`, `stream disconnected`) feeding the SAME ErrorType categories so the supervisor's policies apply unchanged.
- [ ] 8.2 Gemini/Copilot/OpenCode/Cursor: compile + tests green against any type changes; verify each `detectInstallation()` is reachable from the existing startup status route (`checkAllProviders`) — no feature work, availability probing already exists.
- [ ] 8.3 Full unit suite green. Commit `[phase2] Codex 0.139 refresh + ported providers green`.

### Task 9: Phase gate — _Sonnet_

- [ ] 9.1 Full gate on branch: lint + typecheck + `npx vitest run` (≥ baseline counts; new supervisor suites included) + `npm run build`.
- [ ] 9.2 E2E @ `--workers=2` (mock agent unaffected by SDK changes — MockProvider bypasses SDK): parity vs phase1-baseline.md green floor (≥64 passed, failures within documented set).
- [ ] 9.3 Live smoke (manual-ish, scripted): start dev server, confirm `✓ Claude Code CLI authentication detected` still appears with SDK 0.3.173 and `/api/health` 200; kill via `npx kill-port 3008`.
- [ ] 9.4 Update tasks/todo.md (Phase 2 section) + docs/superpowers/plans/phase2-results.md (competition scores, gate numbers). Merge `phase2-provider-layer` → `main` (no-ff), final commit `[phase2] provider layer complete — gate green`.

---

## Execution notes for the orchestrator

- Tasks strictly sequential EXCEPT: Task 1 (types) may run parallel to Task 0; Task 5's two Opus implementers run in parallel (worktree isolation mandatory); Task 6 may run parallel to Task 5 reviews.
- Models: Task 0,2,3,4,7,8,9 → Sonnet; Task 1,6 → Haiku; Task 5 implementers → Opus ×2; Task 5 reviewers → Sonnet ×2.
- Hard rules for all agents: never weaken a harness scenario to make code pass; never reintroduce `TodoWrite`; never change the ProviderMessage consumer contract; Windows shell = git-bash; long commands timeout 600000ms; `npx kill-port` only, never `taskkill //IM node.exe`; commit per task with `[phase2]` prefix.
- Cost guard: Opus agents get tightly-scoped briefs (claude-provider.ts + its tests only); everything else Sonnet/Haiku.
