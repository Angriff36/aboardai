# AboardAI v1 — Design

**Date:** 2026-06-11
**Status:** v1 delivered 2026-06-12 (Phases 1-5 complete; see docs/superpowers/plans/phase5-results.md)
**Author:** Claude (orchestrator) with Ryan

## Summary

AboardAI is a hard-fork of [automaker](c:/Projects/referencerepos/automaker) (MIT, archived May 2026): a desktop/web application in which AI coding agents autonomously plan, implement, and verify features for a user's projects. The fork preserves automaker's three proven strengths — the auto-mode execution loop, the lifecycle prompt library, and the spec/ideation system — and replaces its two failure points: an unreliable provider/connectivity layer and stale model support. Selected capabilities from three other open-source references (vibe-kanban, OpenHands, ai-agent-board) are grafted in where they strengthen v1.

## Goals

1. **Auto-mode that works**: features move backlog → planning → implementation → verification → done without babysitting, surviving connection drops and server restarts.
2. **Current models, easy updates**: Claude Code (subscription auth) as flagship provider; Codex first-class; all providers behind one adapter interface so a model/provider update is a one-file change.
3. **Keep the prompt quality**: automaker's lifecycle prompts (planning lite/spec/full-SDD, implementation, verification, follow-up, continuation, resume) carried over and re-tuned for 2026-era models.
4. **Keep ideation**: category-driven generation of up to ~100 feature suggestions with project context to avoid duplicates.
5. **New: task groups** with a max-concurrency slider, per-child retry, and auto-advance to review.
6. **New: normalized agent event log** persisted to disk, powering clean activity feeds and reliable resume.

## Non-goals (v1)

- Diff review with inline comments sent back to agents (roadmap)
- One-click PR creation / GitHub flow (roadmap; local merge stays)
- Cloud hosting, multi-user, sandboxed runtimes (OpenHands-style) — single-user local tool
- Mobile UI

## Foundation decision

**Hard-fork automaker** rather than greenfield or hybrid. Rationale: it is MIT-licensed TypeScript containing exactly the valued features (~209k LOC, ~163 Playwright E2E tests across 26 spec files, clean monorepo with 8 shared libs); rebuilding the working 80% would add weeks of agent-hours and regression risk for no benefit. The weak 20% (providers, half-finished auto-mode refactor) is replaced surgically.

License compliance: automaker is MIT — we retain its copyright notice in `LICENSE`/`NOTICE` and license AboardAI under MIT. vibe-kanban is Apache-2.0 and Rust; we borrow _ideas_ (adapter pattern, log normalization, worktree race-safety), not code. ai-agent-board and OpenHands are MIT.

## Architecture

Inherited from automaker, with renames:

```
apps/
  server/   Express 5 + ws backend (port 3008)
  ui/       React 19 + Vite + Electron 39 frontend (port 3007)
libs/
  types/ utils/ platform/ prompts/ model-resolver/
  dependency-resolver/ git-utils/ spec-parser/      (@aboardai/* packages)
```

Per-project data lives in `{project}/.aboardai/` (features, ideation, spec); global data in `DATA_DIR` (settings, credentials, sessions). JSON on disk with atomic writes and backups, as in automaker. No database in v1 (the ai-agent-board SQLite repository pattern is a roadmap candidate if JSON becomes a bottleneck).

### Component 1 — Provider layer (rebuilt)

A single `AgentProvider` interface (inspired by vibe-kanban's `StandardCodingAgentExecutor` trait):

- `executeQuery(opts): AsyncGenerator<ProviderEvent>` — streaming execution
- `resumeSession(sessionId, opts)` — continue an interrupted session. **Net-new capability** (no equivalent in automaker's `BaseProvider`); Phase 2 must first research what the current Claude Agent SDK and Codex SDK expose for session continuity rather than assume a port.
- `detectAvailability()` — CLI/auth probe at startup (ai-agent-board pattern)
- `listModels()` — current model catalog per provider

Implementations, in priority order:

1. **ClaudeProvider** — latest `@anthropic-ai/claude-agent-sdk`; auth is **API-key first** with local CLI-login passthrough as the SDK's default behavior for personal use _(amended 2026-06-11 — see Amendment A1)_; models: Opus 4.8, Sonnet 4.6, Haiku 4.5 with alias resolution in `@aboardai/model-resolver`.
2. **CodexProvider** — current `@openai/codex-sdk`.
3. **GeminiProvider, CopilotProvider, OpenCodeProvider** — ported from automaker behind the new interface, availability-probed, best-effort.

**Reliability contract (the core fix):** every provider stream is wrapped in a supervisor that (a) heartbeats and detects stalls, (b) reconnects with exponential backoff, (c) resumes via provider session IDs instead of restarting features, (d) classifies errors (rate-limit vs auth vs network vs fatal) with distinct retry policies, and (e) emits structured status so the UI always knows the real state.

### Component 2 — Auto-mode engine (refactor completed)

Keep automaker's facade + sub-services (loop coordinator, execution service, agent executor, concurrency manager, worktree resolver, recovery service, plan approval, feature state manager). Work items:

- Finish the partial refactor (remove the legacy 216 KB service remnants; implement the `analyzeProject()` TODO).
- Replace sentinel-string scraping (`[TASK_START]`, `<summary>`) parsing internals with the normalized event pipeline (Component 3) while keeping the same prompt-visible markers, since the prompts depend on them.
- Verification step unchanged: lint → typecheck → test → build in the feature's worktree, plus the Playwright self-verification instruction in prompts.

### Component 3 — Normalized event pipeline (new)

Every raw provider message is mapped to a `NormalizedEvent` (`file_edit`, `command_run`, `agent_message`, `question`, `task_marker`, `error`, `status`, …) by a per-provider normalizer. Events are:

- appended to `{feature}/events.jsonl` as they happen (crash-safe resume source),
- broadcast over the existing WebSocket to the UI activity feed,
- the single source the auto-mode engine reads for task/summary markers.

### Component 4 — Task groups (new)

From ai-agent-board: a `TaskGroup` holds 2–20 features, `maxConcurrency` (1–N slider), per-child retry count, shared base branch. A `GroupQueue` drains pending children into auto-mode as slots free, marks the group `review` when all succeed, `failed` with per-child detail otherwise. Builds directly on automaker's per-feature worktree isolation; the worktree creation path gets vibe-kanban-style per-path mutex protection against concurrent-creation races.

_Design option (amended 2026-06-11 — see Amendment A2):_ model the TaskGroup/Feature lifecycle in `@angriff36/manifest` (Ryan's domain-modeling DSL) — entities + transition commands with ordered guards ("implementation requires dependencies satisfied AND a free concurrency slot") + emitted events that feed Component 3's `events.jsonl`. Candidate stretch goal: expose board mutations to agents as Manifest agent-sdk guarded tools (`toAnthropicTools()`), so agents cannot make illegal state transitions. Decision deferred to the Phase 4 task plan; Phases 2–3 are unaffected.

### Component 5 — Prompts & ideation (preserved, re-tuned)

`@aboardai/prompts` carries over all ~20 lifecycle prompt templates and the ideation system (9 categories, 35+ guided prompts, JSON suggestion parsing, context assembly from project spec + existing features). Re-tuning pass: update model-era assumptions, port-protection warnings (3007/3008 → new brand), and verify sentinel-marker instructions still parse against the new event pipeline.

## Data flow (happy path)

1. User ideates → suggestions saved as features in `.aboardai/features/`.
2. Auto-mode loop picks an eligible feature (status + dependencies satisfied + concurrency slot).
3. Worktree resolved/created; planning prompt → spec; optional approval gate.
4. Implementation prompt streams through provider supervisor → normalized events → disk + UI.
5. Verification commands run in worktree; on success feature → `review`/`done`; on stream failure supervisor resumes the session; on crash recovery service replays `events.jsonl`.

## Error handling

- **Stream stall**: heartbeat timeout → reconnect/resume, max N attempts → feature `interrupted` (not `failed`), auto-resumable.
- **Rate limit**: backoff with provider-reported retry-after; auto-mode loop lowers effective concurrency while limited.
- **Server crash**: recovery service rebuilds in-flight state from `feature.json` + `events.jsonl` on boot.
- **Group child failure**: retry up to configured count, then mark child failed, keep draining siblings.

## Testing

- Inherit and keep green automaker's Playwright E2E suite (~163 tests in 26 spec files; exact count established as the Phase 1 baseline) and its Vitest unit suites.
- New unit suites: provider supervisor (stall/reconnect/resume via fake provider), normalizers (golden raw→normalized fixtures per provider), GroupQueue (concurrency/retry/advance), worktree mutex.
- Phase gates: each build phase ends with `lint + typecheck + test + build` green before the next phase starts.

## Build orchestration

Five phases, each gated by verification:

1. **Fork & rebrand** — copy source, rename packages/dirs/brand, git init, prove build + dev run on Windows. (Mechanical: Haiku agents.)
2. **Provider layer** — new interface + supervisor; ClaudeProvider built as competing implementations by parallel Opus agents against a shared fault-injection test harness, winner chosen by adversarial review; Codex/others by Sonnet agents. The Phase 2 task plan must define, before agents launch: the fault-injection harness scenarios (stall, disconnect, rate-limit, auth failure, mid-stream crash) and the winner-selection rubric (harness pass rate, then adversarial review findings, then code clarity).
3. **Event pipeline** — normalizers + JSONL persistence + engine integration. (Sonnet.)
4. **Task groups** — model, queue, API, UI. (Sonnet.)
5. **Polish** — full E2E pass, model catalog, prompt re-tune, README/LICENSE/NOTICE. (Sonnet + Haiku.)

## Risks

- **Windows-specific breakage** (node-pty, paths, worktrees): mitigated by Phase 1 proving the stock fork runs before changes.
- **SDK behavioral drift** (new Agent SDK vs 0.1.76): mitigated by the fault-injection harness and competing implementations.
- **Rename sweep misses** (~1,400 files): mitigated by automated search verification (zero remaining `automaker` references outside NOTICE/attribution) as a phase gate.
- **E2E suite assumes old branding/ports**: test updates are in-scope for Phase 1.

## Amendments

**A1 — Auth policy correction (2026-06-11).** Phase 2 SDK research (`docs/superpowers/research/claude-agent-sdk-2026.md`, Q3) found Anthropic policy prohibits third-party apps from _offering_ claude.ai/subscription login without prior approval. Original spec language ("auth via Claude Code subscription login, API key fallback") inverted the permitted order. Corrected design: `ANTHROPIC_API_KEY` is the documented, distributable auth path; the SDK's automatic pickup of a local Claude Code CLI login remains available implicitly for personal use (verified working in the Phase 1 dev-run proof) but is not presented as a product login feature. UI copy and docs must reflect API-key-first.

**A2 — Manifest as Phase 4 domain-model option (2026-06-11).** `@angriff36/manifest` v2.4.x (Ryan's published DSL: entities, commands with ordered guards, policies, events; deterministic runtime; ~3k tests; agent-sdk with `toAnthropicTools()`; MCP server) is approved as a design option for Component 4. Rationale: the TaskGroup/Feature lifecycle is exactly the commands+guards+events shape; Phase 4 is greenfield within the fork so there is no rewrite cost; Manifest events can feed Component 3's `events.jsonl`; its audit sink aligns with the normalized-event-log goal. Scope guard: NOT to be used in Phases 2–3 (provider layer/event pipeline port — wrong shape, scope creep). Version must be pinned (fast-moving dependency). Final adopt/skip decision happens in the Phase 4 task plan; the stretch goal of agent-governed board mutations (guarded tool surface instead of raw JSON writes) is evaluated there too.
