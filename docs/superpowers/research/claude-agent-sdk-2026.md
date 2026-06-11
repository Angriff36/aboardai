# Claude Agent SDK (TypeScript) — Ground-Truth Research

**Date:** 2026-06-11
**Purpose:** AboardAI provider-layer design baseline — pre-design ground truth for the rebuilt provider layer
**Target:** `@anthropic-ai/claude-agent-sdk` TypeScript SDK, current as of June 11, 2026
**Sources:** [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage) | [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks) | [Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop) | [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting) | [Models](https://platform.claude.com/docs/en/about-claude/models) | [Changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

---

## Q1 — Package Name, Latest Version, Breaking Changes vs 0.1.76

**Package:** `@anthropic-ai/claude-agent-sdk` (unchanged)
**Latest version:** 0.3.173 (as of June 11, 2026)
**Install:** `npm install @anthropic-ai/claude-agent-sdk`

The TypeScript SDK bundles a native Claude Code binary as an optional dependency — no separate Claude Code CLI install required. The binary is pinned to the SDK package version; updating the SDK is how you update the underlying CLI.

### Breaking changes from 0.1.76 → 0.3.173 relevant to AboardAI

| Version | Change | Impact on automaker port |
|---------|--------|--------------------------|
| **0.2.113** | `options.env` now **replaces** `process.env` entirely instead of overlaying it. Must spread: `{ ...process.env, MY_VAR: "x" }` | **Low risk** — automaker's `buildEnv()` already constructs an explicit env object and copies only selected vars (PATH, HOME, ANTHROPIC_API_KEY, etc.) via `SYSTEM_ENV_VARS` list. The function never relied on overlay behavior. Verify `SYSTEM_ENV_VARS` is complete for AboardAI's needs. |
| **0.3.142** | `unstable_v2_createSession`, `unstable_v2_resumeSession`, `SDKSession`, `SDKSessionOptions` **removed** | **No impact** — automaker used `query()` with `options.resume`, which is the current API. |
| **0.3.142** | `TodoWrite` tool **removed**; replaced by `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | **Medium impact** — automaker's `TOOL_PRESETS.fullAccess` and `.chat` include `TodoWrite` in their `allowedTools` arrays. These must be updated. Task tools are exported from `@anthropic-ai/claude-agent-sdk/sdk-tools`. |
| **0.3.142** | MCP servers now connect in **background by default** (non-blocking). Slow servers show `status: "pending"` in init message. | **Low impact** — changes startup timing. Restore old blocking behavior with `MCP_CONNECTION_NONBLOCKING=0` if needed. Mark MCP servers `alwaysLoad: true` to require them at startup. |

**`query()` function signature:** Stable across all versions. Still takes `{ prompt, options }` and returns `AsyncGenerator<SDKMessage>`. No breaking changes to the function itself.

---

## Q2 — Session Continuity: resume, forkSession, History Replay, In-Flight Tool Calls

### How sessions work

Session state is a JSONL transcript written to disk at:
```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```
`<encoded-cwd>` = absolute working directory with every non-alphanumeric character replaced by `-` (e.g., `/Users/me/proj` → `-Users-me-proj`). Override with `CLAUDE_CONFIG_DIR` env var.

The transcript stores the full conversation: prompts, every tool call, every tool result, every response. Resuming restores all of this — files already read, analysis already done, decisions already made.

### Session-continuation options on `Options`

| Option | Type | What it does |
|--------|------|-------------|
| `resume` | `string` | Resume a **specific session by ID**. Full context restored. Use when you have multiple sessions or the target is not the most recent. |
| `continue` | `boolean` | Resume the **most recent session** in the current `cwd`. No ID tracking needed. Use for single-conversation-at-a-time apps. |
| `forkSession` | `boolean` | When combined with `resume`, creates a **new session** that starts with a copy of the original's history. Original session unchanged. Fork gets its own session ID. |
| `persistSession` | `boolean` | Set `false` to disable disk persistence. Session exists only in memory for the query duration. Cannot be used with `sessionStore`. |

### Getting the session ID

Two ways to capture `session_id`:
1. **From init `SystemMessage`** (earliest): `if (message.type === "system" && message.subtype === "init") { sessionId = message.session_id; }`
2. **From `SDKResultMessage`** (after completion): `if (message.type === "result") { sessionId = message.session_id; }` — available on all result subtypes including error variants.

### Resuming an interrupted session (the key pattern for AboardAI)

```typescript
// Capture session ID from first run (even error results carry session_id)
for await (const message of query({ prompt: firstPrompt, options: { ... } })) {
  if (message.type === "result") sessionId = message.session_id;
}

// Resume with full context on next run
for await (const message of query({
  prompt: followUpPrompt,
  options: { resume: sessionId, allowedTools: [...] }
})) { ... }
```

The agent picks up with full prior context — no need to re-read files or re-explain the task. This is the correct mechanism for `resumeSession()` in AboardAI's `AgentProvider` interface.

### Cross-host / cross-process resume

Sessions are local to the machine. For cross-host resume, use the `SessionStore` interface (see Q7). The SDK also exposes:
- `listSessions({ dir, limit })` — enumerate sessions for a project directory
- `getSessionMessages(sessionId, { dir })` — read messages from a session
- `renameSession()`, `tagSession()` — organize sessions

### In-flight tool call interruption

There is no mid-stream `resume` during an active `query()` call — the session is written to disk as it progresses, so if the stream is interrupted (network drop, process crash), the completed turns are on disk and `resume: sessionId` on the next call will pick up from the last completed turn. Incomplete turns are not replayed.

The `Query` object (returned by `query()`) has an `interrupt()` method for controlled termination: `await queryObj.interrupt()`. This stops the agent at the next safe point.

---

## Q3 — Auth: OAuth/CLI vs API Key, Precedence, Env Vars, Policy

### Auth methods supported by the SDK

| Method | How to configure | Notes |
|--------|-----------------|-------|
| **Anthropic API key** | `ANTHROPIC_API_KEY` in `options.env` | Primary supported method for third-party apps |
| **Auth token** | `ANTHROPIC_AUTH_TOKEN` in `options.env` | Alternative credential form |
| **Amazon Bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials | |
| **Claude Platform on AWS** | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` + `ANTHROPIC_AWS_WORKSPACE_ID` + AWS credentials | |
| **Google Vertex AI** | `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials | |
| **Microsoft Azure Foundry** | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials | |

### Policy on claude.ai OAuth / subscription auth

**Official policy (quoted from SDK overview docs):**
> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."

**Implication:** AboardAI **cannot** offer Claude Code subscription login (OAuth/CLI credentials) as an auth path for end users without prior Anthropic approval. The auth via "Claude Code subscription login" described in the AboardAI design spec is **not permitted for third-party distribution** unless AboardAI obtains that approval. The fallback (API key) is the only generally permitted method. (For a developer's own personal local use, the SDK's default behavior — picking up the local CLI login when no key is set — is what automaker relied on; the policy constraint applies to *offering* it in a distributed product.)

**Note on what automaker did:** automaker's `buildEnv()` checks for credentials in this priority order: (1) credentials file from UI settings, (2) `process.env.ANTHROPIC_API_KEY`, (3) implicit CLI OAuth (when no key set, SDK handles automatically). Path (3) was the "Claude Max plan" path. Per policy above, Path (3) is not permitted for third-party distribution.

### Key env vars

| Var | Purpose |
|-----|---------|
| `ANTHROPIC_API_KEY` | Standard API key auth |
| `ANTHROPIC_AUTH_TOKEN` | Token-based auth |
| `ANTHROPIC_BASE_URL` | Override API endpoint (e.g., for proxy or Bedrock) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override default Haiku model ID |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override default Sonnet model ID |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override default Opus model ID |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Set `1` to suppress telemetry/update checks |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` directory location |
| `API_TIMEOUT_MS` | Per-request timeout (default 600000ms) |
| `CLAUDE_CODE_MAX_RETRIES` | Max API retries (default 10) |

### Critical: env replacement behavior

Since SDK 0.2.113, `options.env` **replaces** the entire subprocess environment. Always include system vars:
```typescript
options.env = {
  ...process.env,           // OR explicit SYSTEM_ENV_VARS list
  ANTHROPIC_API_KEY: key,
  ANTHROPIC_BASE_URL: baseUrl,
};
```

---

## Q4 — Streaming: Message/Event Shapes, Error Surfacing, Retry/Resume Patterns

### SDKMessage union (full member list as of 0.3.173)

```typescript
type SDKMessage =
  | SDKAssistantMessage       // Claude's response turn (text + tool calls)
  | SDKUserMessage            // Tool results sent back to Claude
  | SDKUserMessageReplay      // Replayed user messages on resume
  | SDKResultMessage          // FINAL message — contains result, cost, session_id
  | SDKSystemMessage          // Session lifecycle (subtype: "init" | "compact_boundary")
  | SDKPartialAssistantMessage // Streaming text deltas (when includePartialMessages: true)
  | SDKCompactBoundaryMessage // Context compaction marker
  | SDKStatusMessage          // Progress updates
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage     // Hook lifecycle
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPluginInstallMessage
  | SDKToolProgressMessage    // Tool execution progress
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage     // Task tool events
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKSessionStateChangedMessage
  | SDKCommandsChangedMessage
  | SDKNotificationMessage
  | SDKFilesPersistedMessage
  | SDKToolUseSummaryMessage
  | SDKMemoryRecallMessage
  | SDKRateLimitEvent         // Rate limit notification
  | SDKElicitationCompleteMessage
  | SDKPermissionDeniedMessage
  | SDKPromptSuggestionMessage  // Predicted next prompt (may arrive after ResultMessage)
  | SDKAPIRetryMessage        // API retry notification
  | SDKMirrorErrorMessage     // SessionStore mirror failure
```

### SDKAssistantMessage shape

```typescript
type SDKAssistantMessage = {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: BetaMessage;      // Full Anthropic API message with content array
  parent_tool_use_id: string | null;  // Non-null inside a subagent
  error?: SDKAssistantMessageError;
};
```
Content blocks are at `message.message.content`, not `message.content`.

### SDKResultMessage shape (final message, every query)

```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success"
         | "error_max_turns"
         | "error_during_execution"
         | "error_max_budget_usd"
         | "error_max_structured_output_retries";
  uuid: string;
  session_id: string;          // Always present — capture for resume
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  api_error_status?: number | null;  // HTTP status code if API error terminated query
  num_turns: number;
  result: string;              // Only populated on "success" subtype
  stop_reason: string | null;  // "end_turn" | "max_tokens" | "refusal" | null
  ttft_ms?: number;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: { [modelName: string]: ModelUsage };
  permission_denials: SDKPermissionDenial[];
  errors?: string[];           // Present on error subtypes
  terminal_reason?: string;    // "completed" | "max_turns" | "tool_deferred" | ...
  structured_output?: unknown; // When outputFormat schema specified
};
```

**Important:** `result` field only populated on `"success"` subtype. Always check `subtype` before reading `result`. All subtypes carry `total_cost_usd`, `session_id`, and `usage` — safe to read for cost/resume on error paths.

**Important:** A small number of trailing messages (e.g., `SDKPromptSuggestionMessage`) can arrive **after** `SDKResultMessage`. Always iterate the stream to completion rather than breaking on the result message.

### Error surfacing patterns

1. **Operational errors** (rate limit, max turns, API error): surface as `SDKResultMessage` with non-success `subtype`. The generator does NOT throw.
2. **Rate limit events**: `SDKRateLimitEvent` is emitted in the stream when rate limits are encountered. Exact fields (including retryAfter) not documented in public-facing pages — **UNCONFIRMED**: check SDK source or TypeScript types for field names.
3. **API retry notifications**: `SDKAPIRetryMessage` emitted when the SDK retries an API call.
4. **Fatal startup errors**: the generator CAN throw an exception for subprocess spawn failures (e.g., binary not found on `PATH`). Wrap `query()` in try/catch for startup errors; check `SDKResultMessage.subtype` for runtime errors.
5. **SessionStore mirror failures**: `SDKMirrorErrorMessage` emitted; query continues (local transcript is preserved).

### Mid-stream reconnect / resume pattern

There is no transparent reconnect within a single `query()` call. The AboardAI supervisor pattern:
1. Detect stall via `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + `CLAUDE_STREAM_IDLE_TIMEOUT_MS` in `options.env`
2. Capture `session_id` from the `init` SystemMessage at stream start
3. On stall/error: abort the current query, start a new `query()` with `options.resume: savedSessionId`
4. The resumed query picks up from the last completed turn on disk

---

## Q5 — Error Classification: Types, Codes, Retry-After

### Result subtype → retry policy

| Subtype | Retryable | Strategy |
|---------|-----------|----------|
| `error_max_turns` | Yes | Resume with higher `maxTurns` |
| `error_during_execution` | Depends on `api_error_status` | Resume if network; check HTTP status |
| `error_max_budget_usd` | Yes | Resume with higher `maxBudgetUsd` |
| `error_max_structured_output_retries` | Yes | Simplify schema or retry |

### HTTP status codes (from `api_error_status`)

| Status | Meaning | Retry? |
|--------|---------|--------|
| 429 | Rate limit | Yes — back off with delay |
| 500/502/503/504 | Server error | Yes — exponential backoff |
| 401 | Auth failure | No — fix credentials |
| 403 | Permission denied | No — fix permissions |
| 400 | Bad request | No — fix request |
| `null` / absent | No API error | N/A |

### Generator-level error handling pattern

```typescript
try {
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant" && message.error) {
      // Per-turn API error, not fatal
    }
    if (message.type === "result" && message.is_error) {
      const httpStatus = message.api_error_status;
      const errors = message.errors;
      // Classify and decide retry
    }
  }
} catch (error) {
  // Only thrown for subprocess spawn failures (binary not found, etc.)
}
```

### Automaker's error-handler compatibility

automaker's `classifyError()` in `error-handler.ts` does pattern matching on error message text via regexes. This is compatible with the current SDK but misses the structured `api_error_status` field and `SDKRateLimitEvent`. AboardAI's redesigned error handler should read `api_error_status` directly instead of relying solely on text matching for HTTP error codes.

---

## Q6 — Model Identifiers

Source: https://platform.claude.com/docs/en/about-claude/models (verified June 11, 2026)

### AboardAI target models

| Model | API ID | Alias | Context | Thinking |
|-------|--------|-------|---------|----------|
| **Opus 4.8** | `claude-opus-4-8` | `claude-opus-4-8` | 1M tokens | Adaptive (always on); effort defaults to `high`; no extended thinking |
| **Sonnet 4.6** | `claude-sonnet-4-6` | `claude-sonnet-4-6` | 1M tokens | Adaptive + extended thinking both supported |
| **Haiku 4.5** | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 200k tokens | Extended thinking (yes); adaptive thinking (no) |

**Notes:**
- All three use the dateless/date-in-ID format. Starting with the 4.6 generation, model IDs are pinned snapshots, not evergreen pointers.
- Haiku 4.5's context window (200k) is smaller than Opus/Sonnet (1M). Relevant for long sessions.
- Opus 4.8 `effort` defaults to `high` on all surfaces including the Agent SDK. Set `effort` explicitly to change this.
- Adaptive thinking on Opus 4.8/Sonnet 4.6: do NOT set `maxThinkingTokens` — the model adjusts automatically. For Haiku 4.5, use `maxThinkingTokens` to control extended thinking budget.

### Model env var overrides (for `buildEnv()` in ClaudeProvider)

```typescript
env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'claude-opus-4-8';
env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'claude-sonnet-4-6';
env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = 'claude-haiku-4-5-20251001';
```

### Other current models (context for model-resolver)

- `claude-fable-5` — most capable widely released model (June 9, 2026); no extended thinking; adaptive always on; $10/$50 per MTok
- `claude-opus-4-7` — legacy Opus tier; adaptive thinking; 1M context
- `claude-opus-4-6` — supports extended thinking; 1M context; 128k output
- Deprecated: `claude-opus-4-1` (retires Aug 5, 2026), `claude-sonnet-4` (retires June 15, 2026), `claude-opus-4` (retires June 15, 2026)

---

## Q7 — New Capabilities Since 0.1.76

### Session management

- **`options.continue: true`** — resume most-recent session without ID tracking (new ergonomic option)
- **`options.forkSession: true`** — branch a session without modifying original
- **`options.persistSession: false`** — ephemeral in-memory sessions (no disk write)
- **`SessionStore` interface** — pluggable external storage for cross-host resume (S3, Redis, Postgres reference adapters in SDK repo at `examples/session-stores/`)
- **`InMemorySessionStore`** — built-in store for testing
- **`listSessions()`, `getSessionMessages()`, `renameSession()`, `tagSession()`, `getSessionInfo()`** — session management utilities
- **`startup()`** — pre-warm the Claude subprocess before the first query, moving initialization cost off the critical path. Returns an object with a `.query()` method.

### Query object methods (on the `Query` async iterator)

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: Partial<Settings>): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```

Notable new methods: `interrupt()` (stop agent cleanly), `rewindFiles()` (undo file changes), `setModel()` / `setPermissionMode()` (runtime reconfiguration), `mcpServerStatus()` (check MCP server health), `streamInput()` (multi-turn input streaming).

### Hooks API (programmatic, in-process)

Full programmatic hooks support via `options.hooks`. Available SDK hooks in TypeScript:

| Hook | Purpose |
|------|---------|
| `PreToolUse` | Intercept/block/modify tool calls before execution |
| `PostToolUse` | Inspect tool results, inject additional context |
| `PostToolUseFailure` | Handle tool execution failures |
| `PostToolBatch` | Fire once per batch of tool calls |
| `UserPromptSubmit` | Inject context into prompts |
| `MessageDisplay` | Redact/reformat displayed text |
| `Stop` | Save state before agent finishes |
| `SubagentStart` | Track subagent spawning |
| `SubagentStop` | Aggregate subagent results |
| `PreCompact` | Archive transcript before compaction |
| `PermissionRequest` | Custom permission handling |
| `SessionStart` | Initialize telemetry/logging (TypeScript only) |
| `SessionEnd` | Clean up resources (TypeScript only) |
| `Notification` | Forward agent status to Slack/PagerDuty |
| `TeammateIdle` | React to idle teammates |
| `TaskCompleted` | Background task completion |
| `WorktreeCreate` / `WorktreeRemove` | Git worktree lifecycle |

### Task tools (replacing TodoWrite)

`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` — structured task management replacing the old `TodoWrite` snapshot model. Types exported from `@anthropic-ai/claude-agent-sdk/sdk-tools`.

### New built-in tools

- **`Monitor`** — watch a background script and react to each output line as an event
- **`ToolSearch`** — dynamically find and load MCP tools on-demand (avoids loading all MCP schemas upfront)
- **`AskUserQuestion`** — ask the user clarifying questions with multiple-choice options mid-loop

### Stream supervision env vars

```
CLAUDE_ENABLE_STREAM_WATCHDOG=1          — enable stream idle watchdog
CLAUDE_STREAM_IDLE_TIMEOUT_MS=<ms>       — main stream idle abort threshold
CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS=<ms> — background subagent stall detection
API_TIMEOUT_MS=<ms>                      — per-request timeout (default 600000ms)
CLAUDE_CODE_MAX_RETRIES=<n>              — max API retries (default 10)
```

### Other notable additions

- **`options.outputFormat`** — JSON schema for structured outputs
- **`options.agents`** — define custom subagents inline (no separate file needed)
- **`options.effort`** — `"low" | "medium" | "high" | "xhigh" | "max"` reasoning depth
- **`options.thinking`** — `{ type: "adaptive" | "enabled" | "disabled" }` explicit thinking control
- **`options.canUseTool`** — custom permission callback function
- **`options.sessionStore`** — attach a SessionStore adapter
- **`options.disallowedTools`** — deny-list specific tools
- **`resolveSettings()`** — inspect resolved settings with provenance for debugging
- **`createSdkMcpServer()`** — create a local MCP server from inline tool definitions
- **`tool()`** — define typed tools with Zod schemas
- **OTEL telemetry** — `CLAUDE_CODE_ENABLE_TELEMETRY=1` enables OpenTelemetry export
- **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`** — suppress auto-memory injection (needed for multi-tenant isolation)

---

## Implications for AboardAI Provider Design

1. **`resumeSession()` maps to `query({ options: { resume: sessionId } })`** — there is no separate resume function; the design spec's `resumeSession()` method is implemented by calling `query()` with `resume: sessionId`. Capture `session_id` from the `init` SystemMessage (available immediately) rather than waiting for the final ResultMessage.

2. **Auth must be API-key first** — claude.ai OAuth/subscription login is prohibited for third-party apps per Anthropic policy (without prior approval). The design spec's "Claude Code subscription login" auth path must be amended: API key is the documented/distributable path; local CLI-login passthrough remains the SDK's default behavior for personal use but cannot be *offered* as a product feature.

3. **`options.env` replacement semantics (0.2.113+)** — automaker's `buildEnv()` is likely already compatible since it constructs an explicit env object. Verify the `SYSTEM_ENV_VARS` list covers all vars the Claude subprocess needs on Windows (particularly `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP`).

4. **Update `TOOL_PRESETS.fullAccess` and `.chat`** — remove `TodoWrite`, add `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` (from `@anthropic-ai/claude-agent-sdk/sdk-tools`). The task accumulation model changes: agents now update tasks by ID rather than replacing a snapshot list.

5. **Stream supervisor implementation** — use `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + `CLAUDE_STREAM_IDLE_TIMEOUT_MS` for main-stream stall detection, and `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` for background subagents. Capture `session_id` from the `init` SystemMessage at stream start so it is available for resume even if the stream is interrupted before `SDKResultMessage` is emitted.

6. **Error classification should use `api_error_status`** — automaker's text-pattern regex approach works but misses the structured HTTP status code. AboardAI's error handler should read `SDKResultMessage.api_error_status` directly for 429/5xx detection, falling back to text patterns for messages without status codes. Monitor `SDKRateLimitEvent` in the stream for proactive rate-limit signaling (exact fields UNCONFIRMED — check package types).

7. **`startup()` for pre-warming** — use `startup({ options })` to pre-warm the Claude subprocess at server boot time, eliminating initialization latency from the first user request.

8. **`SessionStore` for AboardAI's recovery** — the `events.jsonl` persistence in AboardAI's design can be complemented by a `SessionStore` adapter that mirrors Claude session transcripts to AboardAI's data directory, giving the recovery service the full agent transcript, not just normalized events. `InMemorySessionStore` is available for the fault-injection harness.

9. **Thinking/effort configuration per model** — Opus 4.8 defaults to `effort: "high"`, adaptive thinking (do not set `maxThinkingTokens`). Sonnet 4.6 adaptive by default, extended thinking optional. Haiku 4.5 extended-thinking only — use `maxThinkingTokens`. automaker's `buildThinkingOptions()` logic needs updating for these per-model rules.

10. **MCP non-blocking default (0.3.142+)** — sessions start immediately even if MCP servers are slow. Check `mcpServerStatus()` on the Query object if the supervisor must verify MCP health before the first prompt; `alwaysLoad: true` restores blocking startup per server.

---

## Document Metadata

| Field | Value |
|-------|-------|
| SDK version researched | 0.3.173 |
| Research date | 2026-06-11 |
| Automaker SDK version | 0.1.76 |
| Confirmed from official docs | All items except where marked UNCONFIRMED |
| UNCONFIRMED items | SDKRateLimitEvent exact field names (retryAfter/reset_time); exact type string for rate_limit event in `message.type` |
| Next step | Phase 2 fault-injection harness should verify SDKRateLimitEvent fields by inspection of installed package types at `node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts` |
