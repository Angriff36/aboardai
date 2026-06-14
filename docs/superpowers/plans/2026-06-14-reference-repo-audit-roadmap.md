# Post-v1 Reference-Repo Audit & Differentiation Roadmap

**Status:** AUDIT COMPLETE 2026-06-14 — feeds post-v1 work (no code committed by this doc)
**Trigger:** v1 looked/felt like automaker. This doc records an honest audit of what AboardAI actually
differs from automaker, plus a concrete, ranked list of _user-visible_ features worth pulling from the
three unused reference repos to make the product distinct.

---

## 1. Honest baseline: how AboardAI actually differs from automaker

Verified against git history (fork point `9dd5e66` — "import automaker @ 5888d2e").

- The **entire frontend/UX is automaker, essentially unchanged**: board, ideation (100-idea),
  auto-mode, prompt library, terminal, settings. This was deliberate (spec: "keep automaker's
  strengths") but means the app _looks_ like a rename.
- The "793 files changed / 22.5k insertions" headline is inflated by a **706-file rename sweep**
  (`@automaker/* → @aboardai/*`, `.automaker → .aboardai`) — cosmetic churn, not product.
- The genuinely net-new work is ~24 backend source files, all **invisible from the UI**:
  - **Provider layer rebuild** — `providers/provider-supervisor.ts` (heartbeat/backoff/session-resume),
    reworked `claude-provider.ts`, SDK 0.1.76 → 0.3.173. (This was automaker's stated failure point.)
  - **Normalized event pipeline** — `events/normalizer.ts`, `event-log.ts`, `event-renderer.ts` → `events.jsonl`.
  - **Task groups** — `groups/` (engine, store, queue, service, `taskgroup.manifest`) + concurrency.
  - **Guarded agent board-mutation MCP tools** — `lib/agent-tools.ts`.

**Reference-repo reality:** of the 4 repos in `C:/Projects/referencerepos/`, only **ai-agent-board**
contributed anything concrete (the task-groups _concept_, reimplemented on the Manifest DSL).
**vibe-kanban** (Rust) and **OpenHands** (Python) contributed nothing — they were "ideas only."
So v1 = **automaker + rebuilt backend spine + one borrowed concept**, not a synthesis of four repos.

**Conclusion:** the backend rebuild was real and was the point. But all differentiation is invisible.
Making AboardAI _feel_ distinct is a mostly-frontend effort that was never in v1 scope. This roadmap
is that effort.

---

## 2. Audit findings (3 reference repos, user-visible features only)

Each repo was audited by a focused subagent. Full method: find features AboardAI lacks, ranked by value,
with port difficulty given the language mismatch.

### ai-agent-board (TypeScript) — _smaller than AboardAI; most features already covered_

1. Inline "Changes/Actions" tab derived live from the event stream (per-file rollup during the run) — **Medium**
2. Export agent transcript as Markdown — **Easy**
3. Event coalescing + build-noise stripping in the activity feed — **Medium**
4. Parallelism slider as a first-class control in the group dialog — **Easy**
5. Repo-path recent-history autocomplete — **Easy**

### vibe-kanban (Rust backend, TS frontend) — _mature; frontend ideas reusable, Rust logic must be reimplemented_

1. **Inline diff comment → batched feedback loop** (comment on diff lines, sent together to agent) — **Medium**
2. Preview browser with click-to-inspect (element → `file:line` injected into chat) — **Hard**
3. **Multi-attempt task forking** (retry w/ different agent/model/branch, compare, pick winner) — **Medium**
4. Command bar (Cmd/Ctrl+K palette) — **Easy**
5. MCP server config UX with one-click "popular servers" catalog — **Easy–Medium**
6. Agent-transparency cluster (approval cards, ask-user banners, context-usage gauge, todo progress) — **Medium**
7. Slash-command typeahead surfacing the provider's native commands — **Medium**
8. Subtasks with relationships panel — **Easy–Medium**
9. Multi-repo workspaces — **Hard**
10. IDE extension (VSCode/Cursor) — **Hard / separate surface**

### OpenHands (Python backend, TS frontend) — _mature agentic tool; frontend patterns reusable as ideas_

1. **Rich agent trajectory / event-stream rendering** (polymorphic per-event UI: collapsible commands,
   inline diffs, MCP tool-call cards, agent thoughts, typing indicator) — **Medium**
2. **Action confirmation + security-risk gating** (inline Continue/Cancel, risk labels mid-run) — **Medium**
3. Multi-tab workspace panel (Changes / Browser / Code / Planner; Monaco diff viewer) — **Medium–Hard**
4. Skills / microagents (keyword-triggered instruction snippets from repo `.openhands/skills/`) — **Medium**
5. Planner tab + inline plan-preview card — **Easy–Medium**
6. Trajectory export (download conversation JSON) — **Easy**
7. Chat starter suggestions + git control bar — **Easy**
8. MCP server config UI + condenser (context-compaction) settings — **Medium**

---

## 3. Cross-repo convergence (the high-signal gaps)

Where multiple independently-built tools point at the _same_ gap = strongest signal.

| Priority | Feature                                                                               | Converging sources                              | Why it matters                                                                                                             | Effort |
| -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| **P1**   | **Agent trajectory view** (structured per-event UI vs flat log)                       | OpenHands #1, ai-agent-board #3, vibe-kanban #6 | Single biggest reason it "feels like automaker." Backend data already exists (Phase 3). Mostly frontend. Prereq for P2/P4. | Medium |
| **P2**   | **In-app diff review w/ inline comments → batched agent feedback**                    | vibe-kanban #1, OpenHands #3                    | Turns the worktree into a real review→fix→re-review loop. Most distinctive review UX.                                      | Medium |
| **P3**   | **Multi-attempt / forking** (retry w/ different provider/model, compare, pick winner) | vibe-kanban #3                                  | Matches AboardAI's _own_ stated philosophy ("competing implementations judged"). Never built.                              | Medium |
| **P4**   | **Action confirmation + risk gating**                                                 | OpenHands #2                                    | Safety brake for autonomous worktree mutations. Hangs off the same event UI as P1.                                         | Medium |

**Easy-wins batch (do together):** transcript/trajectory export (all 3); Cmd+K command palette (vibe-kanban);
parallelism slider (ai-agent-board).

**Ambitious "wow" (park):** preview browser with click-to-inspect (vibe-kanban #2 / OpenHands browser) — Hard.

---

## 4. P1 deep-dive: current-state of event rendering (verified)

Investigated for the trajectory-view build. **Critical finding: there are two parallel event systems.**

- **Backend has a rich 12-variant `NormalizedEvent` discriminated union** (`libs/types/src/normalized-event.ts`):
  `agent_message`, `thinking`, `tool_use`, `tool_result`, `file_edit`, `command_run`, `question`,
  `task_marker`, `summary`, `status`, `session`, `error`, `result`. Persisted to `events.jsonl` via
  `events/normalizer.ts` + `event-log.ts`. Built in Phase 3.
- **But the UI does NOT consume NormalizedEvents.** The live agent view
  (`apps/ui/src/components/views/board-view/dialogs/agent-output-modal.tsx`) consumes the **legacy
  `AutoModeEvent` text stream** + the rendered `agent-output.md` markdown blob, accumulates it as a
  string, and re-parses markdown back into log sections (`apps/ui/src/components/ui/log-viewer.tsx`).
  The Phase 3 pipeline was never wired to the UI.

**Lossiness to resolve before/during P1** (the normalized stream is currently thin):

- `thinking` stores only `thinkingChars` (length), **not content**.
- `file_edit` carries **path only, no diff**.
- `command_run` carries **command only, no output**.
- `tool_result` truncated to 500 chars.

**Architecture decision for P1 (to settle in brainstorming):**

- **(a) Unify on the normalized pipeline** — enrich events to carry diff/output/thinking, add an endpoint
  to read `events.jsonl`, wire UI to consume structured live + replayed events. Right long-term; retires
  the dual-system tech debt; more work.
- **(b) Build a richer renderer on the existing `AutoModeEvent`/markdown path** — faster, but builds on
  the legacy path and leaves the dual system in place.

Recommendation: lean (a) if effort allows, since it pays down the Phase-3-never-wired debt and unblocks
P2/P4 cleanly.

---

## 5. Recommended sequence

1. **P1 trajectory view** first, alone — highest leverage, backend data mostly exists, prereq for the rest.
2. Re-evaluate after P1 ships and is looked at, then **P2 (review loop)** and **P3 (multi-attempt)**.
3. **P4** folds onto P1's event UI.
4. Easy-wins batch whenever there's a low-energy slot.
5. Preview browser only as a deliberate "wow" milestone.

Out of scope (confirmed low value / wrong shape): kanban board, multi-provider, terminal, settings infra
(already present); SQLite/Postgres dual backend, API-key auth, i18n, cloud relay/WebRTC (infra / SaaS-specific).
