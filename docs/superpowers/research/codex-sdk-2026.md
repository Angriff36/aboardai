# OpenAI Codex SDK/CLI — Ground-Truth Research (June 2026)

**Prepared for:** AboardAI provider layer design  
**Date:** 2026-06-11  
**Sources checked:** developers.openai.com, github.com/openai/codex, npmjs.com, deepwiki.com/openai/codex, automaker reference implementation

---

## 1. Package Names, Versions, and Integration Surface

### Packages

| Package | Purpose | Latest Version (2026-06-11) |
|---|---|---|
| `@openai/codex` | CLI tool — interactive TUI and non-interactive `exec` mode | 0.139.0 |
| `@openai/codex-sdk` | TypeScript SDK for programmatic control | 0.139.0 |
| `openai-codex` | Python SDK (pip) | (same train) |

**The right integration surface for programmatic agent execution with streaming is `@openai/codex-sdk`.** It wraps `@openai/codex` CLI under the hood — spawning it and exchanging JSONL events over stdin/stdout — so both packages must be installed. The SDK provides TypeScript types, thread management, and `runStreamed()` for structured event consumption.

- Node.js 18+ required per official SDK docs; one npm search result noted Node.js 22+ for the npm CLI installation path.
- `@openai/codex` uses platform-specific binary dist-tags; the SDK pulls it as a peer dependency.
- Install: `npm install @openai/codex-sdk @openai/codex`

**Sources:**  
- https://developers.openai.com/codex/sdk  
- https://www.npmjs.com/package/@openai/codex-sdk  
- https://www.npmjs.com/package/@openai/codex  
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md

---

## 2. Session / Thread Continuity and `resumeSession`

### Thread Primitives

Codex uses three durable concepts:

- **Thread** — a conversation container with a UUID (`ThreadId`). Persisted to `~/.codex/sessions/YYYY/MM/DD/rollout-TIMESTAMP-UUID.jsonl`.
- **Turn** — one request/response cycle within a thread.
- **Item** — atomic unit of input or output (agent message, command execution, file change, tool call, etc.).

### SDK API

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({ /* options */ });

// New thread
const thread = codex.startThread({ workingDirectory?: string; skipGitRepoCheck?: boolean });
const result = await thread.run("Fix the CI failures");

// Continue the SAME in-memory thread (subsequent turns)
const result2 = await thread.run("Now write the tests");

// Resume a PAST thread by ID (across process restarts)
const threadId = thread.id;                        // string UUID, available after first run()
const thread2 = codex.resumeThread(threadId);
const result3 = await thread2.run("Pick up where we left off");
```

### What Happens on `resumeThread(id)`

1. The rollout JSONL file is located in `~/.codex/sessions/` (indexed via a local SQLite db).
2. `RolloutRecorder::load_rollout_items` reads and filters legacy items.
3. `ContextManager` replays the event history; `TruncationPolicy` trims to fit the model's context window.
4. `SessionMeta` and `TurnContext` restore the working directory, model provider, approval policy, and sandbox settings from when the session was created.
5. If the resumed model differs from the current config, a warning event is emitted (does **not** abort).
6. Configuration override mismatches are logged via `collect_resume_override_mismatches`.
7. Inactive rollout files are Zstandard-compressed on disk; on resume they are transparently decompressed.

### CLI Equivalent

```bash
# Non-interactive resume (exec subcommand)
codex exec resume <SESSION_ID> --json - < prompt.txt
codex exec resume --last "Fix the race condition you found" --json -
```

`--ephemeral` skips writing rollout files entirely (no future resume possible).

### Known Windows Issue

**UNCONFIRMED (open at time of research — GitHub Issue #24944):** Codex may reject a valid resume path when the Windows session path differs only by a `\\?\` long-path prefix. When this triggers, Codex requires starting a new session or manually transferring context. Mitigation: normalize paths before storing `threadId`.

**Sources:**  
- https://developers.openai.com/codex/sdk  
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md  
- https://deepwiki.com/openai/codex/4.4-session-resumption-and-forking  
- https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay  
- https://github.com/openai/codex/issues/24944

---

## 3. Authentication

### Two Primary Paths

| Method | Description | How to Invoke |
|---|---|---|
| **API Key** | `OPENAI_API_KEY` environment variable, or passed directly to SDK | `new Codex({ env: { OPENAI_API_KEY: "sk-..." } })` or `codex login --with-api-key` |
| **ChatGPT OAuth** | Browser or device-code flow; token managed by Codex CLI in `~/.codex/` | `codex login` (interactive) or `codex login --device-auth` |
| **Access Token (external)** | Host app supplies access token, handles refresh (experimental) | App-server `account/login/start` with `chatgptAuthTokens` type |
| **Enterprise tokens** | `CODEX_API_KEY` env var; short-lived server tokens replace ChatGPT tokens | Config `model_providers.<id>.env_key` |

The `forced_login_method` config key (`chatgpt | api`) restricts which method Codex will accept. Useful to ensure API-key-only in automated pipelines.

ChatGPT OAuth tokens are automatically refreshed 5 minutes before expiry. When a token becomes unrefreshable (e.g. reused token), Codex emits a relogin-required event.

### Detecting Auth Programmatically

```bash
codex login status   # exits 0 when logged in; outputs "logged in" text to stderr
```

The automaker reference implementation checks both stdout and stderr for the string `"logged in"`, since the CLI outputs to stderr. Also checks `OPENAI_API_KEY` env var presence as a fast path.

App-server alternative: `account/status` JSON-RPC call returns current auth state.

### Model Access Gating

Some models (gpt-5.3-codex and above) require a ChatGPT Pro/Plus/Team subscription and OAuth login. API-key-only access may succeed for billing but be rejected with `model_not_found` / `do not have access` for subscription-gated models. Detect by error string matching; direct users to `codex login`.

**Sources:**  
- https://developers.openai.com/codex/cli/reference  
- https://developers.openai.com/codex/config-reference  
- https://developers.openai.com/codex/app-server  
- automaker: `/apps/server/src/lib/codex-auth.ts`

---

## 4. Streaming Event Model

### Two SDK Methods

| Method | Returns | Use case |
|---|---|---|
| `thread.run(input, opts)` | `Promise<{ finalResponse: unknown; items: unknown[] }>` | Simple turn; blocks until complete |
| `thread.runStreamed(input, opts)` | `Promise<{ events: AsyncGenerator<Event> }>` | Streaming; yields events as they arrive |

### Event Types (TypeScript SDK `runStreamed`)

Seven structured event types:

| Event Type | Description |
|---|---|
| `ThreadStartedEvent` | Thread lifecycle begins |
| `TurnStartedEvent` | New turn begins |
| `TurnCompletedEvent` | Turn finished; includes `usage` (token counts) |
| `TurnFailedEvent` | Turn ended in error; includes error details |
| `ItemStartedEvent` | Item (message/command/file-change) started; includes `item.id`, `item.status: "in_progress"` |
| `ItemUpdatedEvent` | Streaming delta for an in-progress item |
| `ItemCompletedEvent` | Item finished; includes final item data |
| `ThreadErrorEvent` | Thread-level error (not turn-scoped) |

### CLI JSONL Event Types (`--json` flag)

These are emitted as newline-delimited JSON on stdout:

| JSONL event type | Description |
|---|---|
| `thread.started` | Thread UUID assigned; `thread_id` field |
| `turn.started` | Turn begins |
| `turn.completed` | Turn done; includes `result` text |
| `turn.failed` | Turn error |
| `item.started` | Item in progress; `item.type` field identifies kind |
| `item.updated` | Delta event (e.g. `item/agentMessage/delta`, `item/commandExecution/outputDelta`) |
| `item.completed` | Item done with final data |
| `error` | Top-level error |

### Item Types

Items surfaced within `item.*` events:

- `agent_message` (or `agentMessage`) — model text output
- `reasoning` — model's internal reasoning tokens
- `command_execution` — shell command; carries `command` text and `output`
- `file_change` — file modification diff; may trigger approval request
- `mcp_tool_call` — MCP server tool invocation
- `web_search` — live web search
- `plan_update` / `todo_list` — todo/plan item updates
- `user_message` — input turn

### Known Streaming Bug

**GitHub Issue #10141 (status as of research: open or recently fixed):** In `--json` mode, `command_execution` items can emit output only via `ExecCommandOutputDelta` events while `ExecCommandEnd.aggregated_output` is empty, causing the final JSONL item to lose command output. Mitigation: accumulate deltas and fall back to concatenated delta output when `aggregated_output` is empty (automaker implements this pattern).

### Errors Mid-Stream

Turn-level errors surface as `turn.failed` events (CLI) or `TurnFailedEvent` (SDK). Thread-level errors emit `error` (CLI) or `ThreadErrorEvent` (SDK). The stream continues to be readable after most errors; the caller should check event type before consuming `item` data.

**Sources:**  
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md  
- https://developers.openai.com/codex/noninteractive  
- https://github.com/openai/codex/issues/10141  
- https://www.infoq.com/news/2026/02/opanai-codex-app-server/

---

## 5. Error Classification

### Categories and Manifestations

| Category | How it surfaces | Retry-After available? | Strategy |
|---|---|---|---|
| **Rate limit (429)** | JSONL `error` event or `turn.failed`; error object has `code: "rate_limit_exceeded"`, natural-language message with delay | Parsed from message text (not a header in JSONL mode) | Exponential backoff; parse delay from message. Prior to fix #5956, only OpenAI-format phrasing was parsed — alternative phrasing fell back to generic backoff. Now multi-format. |
| **Auth / 401** | `stream error: last status: 401 Unauthorized`; or `error` event with auth/unauthorized text | No | Check `OPENAI_API_KEY`; prompt `codex login` |
| **Model not found** | `error` event; message contains `"does not exist"`, `"model_not_found"`, `"invalid_model"`, or `"do not have access"` | No | Surface model-gating message; suggest `codex login` for subscription models |
| **Stream disconnection** | `turn.failed` or process exit; message contains `"stream disconnected"`, `"stream ended"`, `"connection reset"`, `"socket hang up"` | No | Retry with session resume if thread ID was captured |
| **Network / transient** | Process-level error, timeout, or `turn.failed` with network message | No | Retry with backoff; resume thread if applicable |
| **Fatal / non-retryable** | CLI exits non-zero before producing `thread.started`; no thread ID captured | N/A | Report error; no resume possible |
| **MCP required-server failure** | `codex exec` exits with error at startup if a `required = true` MCP server fails to initialize | No | Check MCP config before launch |

### Retry Configuration (from `config.toml`)

- HTTP retry count: default **4**
- SSE stream idle timeout: default **300,000 ms**
- SSE stream retry count: default **5**

These can be overridden in config.

**Sources:**  
- https://github.com/openai/codex/issues/4161  
- https://github.com/openai/codex/issues/2612  
- https://github.com/openai/codex/issues/2896  
- https://developers.openai.com/codex/config-reference  
- automaker: `/apps/server/src/providers/codex-provider.ts` (error classification patterns)

---

## 6. Sandbox and Approval Modes for Autonomous Coding Agent on Windows

### Sandbox Modes (`--sandbox` / `sandbox_mode`)

| Mode | Filesystem access | Network | Recommended use |
|---|---|---|---|
| `read-only` | Read only | Default | Inspection, analysis |
| `workspace-write` | Read + write inside working directory | Default | **Recommended for unattended autonomous coding** |
| `danger-full-access` | Unrestricted | Unrestricted | Isolated VMs only |

Safety recommendation from official docs: "Use `--sandbox workspace-write` for unattended local work that can stay inside the workspace, and avoid `--dangerously-bypass-approvals-and-sandbox` unless inside a dedicated sandbox VM."

Use `--add-dir <path>` to grant write access to additional directories without escalating to full access.

### Approval Modes (`--ask-for-approval` / `approval_policy`)

| Mode | Behavior | Recommended use |
|---|---|---|
| `on-request` | Pause for user approval on unfamiliar operations | Interactive runs |
| `untrusted` | Require approval for operations outside known-safe set | Supervised automation |
| `never` | No approval prompts | **Fully autonomous non-interactive pipelines** |

Granular form: `approval_policy = { granular = { sandbox_approval = bool, rules = bool, mcp_elicitations = bool, ... } }` allows per-category control.

`approvals_reviewer = "auto_review"` enables a reviewer subagent to automatically approve/deny — useful when human is absent but full `never` is too permissive.

The deprecated `--full-auto` flag triggers a warning; use `--ask-for-approval never` instead.

### Windows-Specific Notes

- Codex CLI runs natively on Windows via PowerShell or the standalone installer (`irm https://chatgpt.com/codex/install.ps1 | iex`).
- WSL2 available for Linux-native sandbox behavior.
- Windows sandbox uses native Landlock-equivalent; `--elevated` provisioning path is **alpha** as of 0.136.0.
- App-server provides async sandbox setup events: `windowsSandbox/setupStart` / `windowsSandbox/setupCompleted`.
- SQLite intrinsics are disabled for Windows x64 builds.
- **UNCONFIRMED:** Windows worktree setup uses deep links (changelog 0.136.0); UAC manifest restored. Exact impact on sandbox behavior in headless/server context unclear.

**Sources:**  
- https://developers.openai.com/codex/cli/reference  
- https://developers.openai.com/codex/config-reference  
- https://developers.openai.com/codex/app-server  
- https://developers.openai.com/codex/changelog (v0.136.0)

---

## 7. Current Model IDs

All models accessible through the Codex CLI/SDK. The bare model string (without any provider prefix) is what the `--model` flag and SDK `model` option accept.

### Codex-Specific Models (require Codex CLI; some require ChatGPT subscription)

| Model string | Tier | Context | Max output | Reasoning | Vision |
|---|---|---|---|---|---|
| `gpt-5.3-codex` | Premium | 256k | 32k | Yes | Yes |
| `gpt-5.3-codex-spark` | Premium | 256k | 32k | Yes | Yes |
| `gpt-5.2-codex` | Premium | 256k | 32k | Yes | Yes |
| `gpt-5.1-codex-max` | Premium | 256k | 32k | Yes | Yes |
| `gpt-5.1-codex` | Standard | 256k | 32k | Yes | Yes |
| `gpt-5.1-codex-mini` | Basic | 128k | 16k | No | Yes |
| `gpt-5-codex` | Standard | 128k | 16k | Yes | Yes |
| `gpt-5-codex-mini` | Basic | 128k | 16k | No | Yes |

**GPT-5.3-Codex-Spark** is a research preview optimized for real-time coding: 1000+ tokens/sec, text-only at launch, 128k context.

### General-Purpose GPT Models (also available through Codex CLI)

| Model string | Context | Max output | Reasoning |
|---|---|---|---|
| `gpt-5.2` | 256k | 32k | Yes |
| `gpt-5.1` | 256k | 32k | Yes |
| `gpt-5` | 128k | 16k | Yes |

### Reasoning Effort

Models with reasoning support accept `model_reasoning_effort`: `minimal | low | medium | high | xhigh`.  
Also: `model_reasoning_summary`: `auto | concise | detailed | none`.

### Plan-Mode Reasoning

Separate `plan_mode_reasoning_effort` config key for Plan mode turns.

**UNCONFIRMED:** Exact API-facing model ID strings (e.g., whether `gpt-5.4` used in CLI docs is the correct wire name). The official model IDs page at https://developers.openai.com/codex/models/ was not directly fetched; values above are corroborated from changelog, config-reference, and automaker reference implementation.

**Sources:**  
- https://developers.openai.com/codex/config-reference  
- https://developers.openai.com/codex/changelog  
- automaker: `/apps/server/src/providers/codex-models.ts`, `/libs/types/src/codex-models.ts`

---

## Reference: Automaker Integration Patterns

The automaker reference codebase at `C:\Projects\referencerepos\automaker\apps\server\src\providers\` provides a battle-tested implementation with two execution paths:

**Path 1 — SDK mode** (`codex-sdk-client.ts`): Uses `@openai/codex-sdk` directly. Passes `apiKey` to constructor. Calls `codex.startThread(opts)` or `codex.resumeThread(sdkSessionId, opts)` with model + reasoning effort. Calls `thread.run(promptText, { signal })`. Reads `result.finalResponse` and `thread.id`. Falls back to new thread if resume throws.

**Path 2 — CLI spawn mode** (`codex-provider.ts`): Spawns `codex exec [resume] --json --model <m> --config key=val ... -` with prompt on stdin. Parses JSONL stream. Tracks `thread_id` from events. Stores as `this._lastSessionId`. Uses `CODEX_RESUME_SUBCOMMAND` (`resume`) with explicit session ID arg for resume turns. Handles `turn.completed`, `item.started`/`item.completed` for `command_execution`/`reasoning`/`todo_list`, and `error` events.

The automaker implementation uses CLI spawn mode as the primary path (for MCP server support via `codex-config-manager.ts` writing `.codex/config.toml`), falling back to SDK mode when no MCP servers are needed and an API key is available. This is a useful design heuristic for AboardAI.

---

## Implications for AboardAI Provider Design

1. **Dual execution path is justified.** The SDK path is cleaner for simple turns (API key + no MCP); the CLI spawn path is required for MCP server injection via `.codex/config.toml`. Plan for both and route based on `mcpServers` presence and auth method.

2. **`resumeSession(sessionId, opts)` maps to `codex.resumeThread(sessionId)` in SDK mode and `codex exec resume <sessionId>` in CLI mode.** The thread ID (UUID) is the canonical session handle. Capture it from `thread.id` (SDK) or the `thread_id` field on `thread.started` JSONL events (CLI). Always persist across turns.

3. **The SDK's `runStreamed()` is the correct streaming surface.** Do not poll `run()`. Use `runStreamed()` and consume `ItemStartedEvent`, `ItemUpdatedEvent`, `ItemCompletedEvent`, `TurnCompletedEvent`, `TurnFailedEvent`, `ThreadErrorEvent` for full stream supervision.

4. **Thread persistence is local-disk only (`~/.codex/sessions/`).** There is no cloud-hosted session store accessible via ID. `resumeThread` requires the same machine or shared filesystem. This is a significant constraint for distributed/cloud AboardAI deployments — plan for session migration or pin sessions to specific workers.

5. **Windows-specific path normalization is required.** Store thread IDs as-is from Codex output; do not transform with `\\?\` long-path prefix or path separators. Issue #24944 shows resume fails when path strings differ only by prefix format.

6. **Auth detection needs two checks: env var (`OPENAI_API_KEY`) and CLI command (`codex login status`).** The CLI outputs "logged in" to stderr, not stdout. Model-gating errors (subscription-required models) are distinct from auth errors; surface them separately with actionable guidance to run `codex login`.

7. **Error classification needs string-matching on Codex error messages** — there is no structured error code enum in the JSONL stream. Key signals: `rate_limit`, `429`, `unauthorized`, `401`, `model_not_found`, `does not exist`, `stream disconnected`, `connection reset`. Automaker's pattern is the correct approach.

8. **For autonomous coding on Windows, use `--sandbox workspace-write` + `--ask-for-approval never`.** Avoid `danger-full-access` outside VM. The Windows alpha elevated sandbox (`--elevated`) is not production-ready as of 0.136.0.

9. **`gpt-5.3-codex` is the recommended default model** (Premium tier, 256k context, reasoning). Fall back to `gpt-5.1-codex` for users without Pro/Plus subscription. `gpt-5.3-codex-spark` is attractive for high-throughput cheap tasks but is text-only (no vision) at research-preview stage.

10. **`runStreamed()` must accumulate `command_execution` output deltas as a fallback** for the known bug where `aggregated_output` can be empty even when output was streamed. Concatenate `outputDelta` events in memory and use as the final command output if `aggregated_output` is absent.
