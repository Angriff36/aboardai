# SDK 0.3.x Verified Type Definitions

**Verified against installed packages:**

- `@anthropic-ai/claude-agent-sdk` **0.3.173** — source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (6460 lines) and `sdk-tools.d.ts` (3215 lines)
- `@openai/codex-sdk` **0.139.0** — source: `node_modules/@openai/codex-sdk/dist/index.d.ts` (276 lines)
- `@modelcontextprotocol/sdk` bumped to **1.29.0** (required as peer dep by claude-agent-sdk 0.3.173; was 1.25.2)

---

## (a) Rate-Limit Stream Event

**Type name:** `SDKRateLimitEvent`  
**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

```typescript
export declare type SDKRateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID;
  session_id: string;
};

export declare type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?:
    | 'overage_not_provisioned'
    | 'org_level_disabled'
    | 'org_level_disabled_until'
    | 'out_of_credits'
    | 'seat_tier_level_disabled'
    | 'member_level_disabled'
    | 'seat_tier_zero_credit_limit'
    | 'group_zero_credit_limit'
    | 'member_zero_credit_limit'
    | 'org_service_level_disabled'
    | 'no_limits_configured'
    | 'fetch_error'
    | 'unknown';
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  surpassedThreshold?: number;
};
```

**Fields confirmed:** `type`, `rate_limit_info` (nested `SDKRateLimitInfo`), `uuid`, `session_id`. The research doc's UNCONFIRMED field list is now CONFIRMED — no top-level `resetsAt` etc.; those are nested inside `rate_limit_info`.

---

## (b) SDKResultMessage Subtypes + api_error_status

**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

```typescript
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

export declare type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  duration_ms: number;
  duration_api_ms: number;
  ttft_ms?: number;
  ttft_stream_ms?: number;
  time_to_request_ms?: number;
  time_to_request_from_spawn_ms?: number;
  warm_spare_claimed?: boolean;
  is_error: boolean;
  api_error_status?: number | null; // ← CONFIRMED: optional number | null
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  deferred_tool_use?: SDKDeferredToolUse;
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  origin?: SDKMessageOrigin;
  uuid: UUID;
  session_id: string;
};

export declare type SDKResultError = {
  type: 'result';
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  errors: string[];
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  origin?: SDKMessageOrigin;
  uuid: UUID;
  session_id: string;
  // NOTE: NO api_error_status on SDKResultError — only on SDKResultSuccess
};
```

**Key finding:** `api_error_status` is `number | null | undefined` (optional). It is ONLY present on `SDKResultSuccess`, NOT on `SDKResultError`. Type is `number | null` (not `string`).

---

## (c) Init System Message Shape (session_id location)

**Type name:** `SDKSystemMessage`  
**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

```typescript
export declare type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  agents?: string[];
  apiKeySource: ApiKeySource;
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: {
    name: string;
    status: string;
  }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: {
    name: string;
    path: string;
  }[];
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string; // ← session_id lives here on the system init message
};
```

**`session_id`** is a top-level field on the `SDKSystemMessage` (the first stream event with `type: 'system'`, `subtype: 'init'`). It is also present on `SDKResultSuccess`, `SDKResultError`, and `SDKRateLimitEvent`.

---

## (d) Env Var Constants and Watchdog Options

**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

**Exported constant:**

```typescript
export declare const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
```

**`CLAUDE_CODE_WATCHDOG_TIMEOUT`:** NOT exported as a typed constant in the `.d.ts` files. No watchdog-related options found in the `Options` type.

**`env` field on `Options`:**

```typescript
// In Options type:
env?: {
    [envVar: string]: string | undefined;
};
```

JSDoc: "When set, this value REPLACES the subprocess environment entirely — it is not merged with `process.env`. Spread `process.env` yourself if the subprocess still needs inherited variables like `PATH`, `HOME`, or `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`."

---

## (e) Task Tool Exports

**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

The Task tools are exported as **input schema interfaces** (not callable functions — they're tool schema definitions the SDK registers internally):

```typescript
export interface TaskCreateInput {
  subject: string; // brief title
  description: string; // what needs to be done
  activeForm?: string; // present-continuous spinner text e.g. "Running tests"
  metadata?: { [k: string]: unknown };
}

export interface TaskGetInput {
  taskId: string;
}

export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: ('pending' | 'in_progress' | 'completed') | 'deleted';
  addBlocks?: string[]; // task IDs this task blocks
  addBlockedBy?: string[]; // task IDs that block this task
  owner?: string;
  metadata?: { [k: string]: unknown };
}

export interface TaskListInput {} // no params — lists all tasks
```

**Export names:** `TaskCreateInput`, `TaskGetInput`, `TaskUpdateInput`, `TaskListInput` from `sdk-tools.d.ts`. These are the **input type** interfaces. The tool names used in `allowedTools` / tool lists are `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList` (without `Input` suffix). There is NO `TaskDelete` — use `TaskUpdateInput` with `status: "deleted"`.

**Removed tool:** `TodoWrite` — CONFIRMED absent from sdk-tools.d.ts in 0.3.173.

---

## (f) Options Type — Session Control Fields

**Source:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

All six requested fields confirmed present and their exact types:

```typescript
export declare type Options = {
  // ... (many other fields) ...

  /** Continue the most recent conversation in the current directory.
   *  Mutually exclusive with `resume`. */
  continue?: boolean;

  /** When true, resumed sessions fork to a new session ID rather than
   *  continuing the previous session. Use with `resume`. */
  forkSession?: boolean;

  /** When false, disables session persistence to disk.
   *  @default true */
  persistSession?: boolean;

  /** Session ID to resume. Loads conversation history from the specified session. */
  resume?: string;

  /** Environment variables for the Claude Code process.
   *  REPLACES process.env entirely when set. */
  env?: {
    [envVar: string]: string | undefined;
  };

  /** System prompt configuration:
   *  - string: custom prompt
   *  - string[]: array of blocks (supports SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker)
   *  - preset object: use Claude Code default prompt with optional append/excludeDynamicSections */
  systemPrompt?:
    | string
    | string[]
    | {
        type: 'preset';
        preset: 'claude_code';
        append?: string;
        excludeDynamicSections?: boolean; // ← NEW in 0.3.x, not in local SystemPromptPreset type
      };

  // ... additional fields: sessionId, resumeSessionAt, model, maxTurns,
  //     mcpServers, permissionMode, allowedTools, cwd, abortController,
  //     agents, plugins, hooks, thinking, effort, maxBudgetUsd, etc.
};
```

**IMPORTANT:** `SystemPromptPreset` in `@aboardai/types/src/provider.ts` is currently:

```typescript
export interface SystemPromptPreset {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
  // MISSING: excludeDynamicSections?: boolean
}
```

The SDK 0.3.x type adds `excludeDynamicSections?: boolean`. The local type needs updating in Task 4.

---

## Codex SDK (@openai/codex-sdk 0.139.0)

**Source:** `node_modules/@openai/codex-sdk/dist/index.d.ts`

### resumeThread — CONFIRMED

```typescript
declare class Codex {
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
}
```

### runStreamed — CONFIRMED (on Thread class)

```typescript
declare class Thread {
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>;
  run(input: Input, turnOptions?: TurnOptions): Promise<Turn>;
}
```

### Thread Event Types

```typescript
type ThreadEvent =
  | ThreadStartedEvent // type: "thread.started" — has thread_id (use for resumeThread)
  | TurnStartedEvent // type: "turn.started"
  | TurnCompletedEvent // type: "turn.completed" — has usage
  | TurnFailedEvent // type: "turn.failed" — has error
  | ItemStartedEvent // type: "item.started" — has item: ThreadItem
  | ItemUpdatedEvent // type: "item.updated" — has item: ThreadItem
  | ItemCompletedEvent // type: "item.completed" — has item: ThreadItem
  | ThreadErrorEvent; // type: "error" — has message
```

### ThreadItem Union

```typescript
type ThreadItem =
  | AgentMessageItem // type: "agent_message" — text response
  | ReasoningItem // type: "reasoning"
  | CommandExecutionItem // type: "command_execution"
  | FileChangeItem // type: "file_change"
  | McpToolCallItem // type: "mcp_tool_call"
  | WebSearchItem // type: "web_search"
  | TodoListItem // type: "todo_list"
  | ErrorItem; // type: "error"
```

### CodexOptions (top-level)

```typescript
type CodexOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexConfigObject;
  env?: Record<string, string>; // replaces process.env when provided
};
```

---

## Compile-Break Inventory (as of 0.3.173 install)

**Total errors: 5 across 4 files**

| File                                           | Errors             | Root Cause                                                                                                                                                                          |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/providers/claude-provider.ts` | 1 (line 265)       | `ContentBlockParam` type narrowed — prompt array type `{ type: string; text?: string; source?: object }[]` missing required `SearchResultBlockParam` fields (`content`, `title`)    |
| `apps/server/src/services/agent-service.ts`    | 1 (line 554)       | `sdkOptions.systemPrompt` is `string \| string[] \| preset \| undefined` but `ExecuteOptions.systemPrompt` only accepts `string \| SystemPromptPreset \| undefined` (no `string[]`) |
| `apps/server/src/services/auto-mode/facade.ts` | 1 (line 357)       | Same root cause — passing `sdkOptions.systemPrompt` which includes `string[]` into typed field that doesn't accept `string[]`                                                       |
| `apps/server/src/services/ideation-service.ts` | 2 (lines 257, 749) | Same root cause — passing `sdkOptions.systemPrompt` which includes `string[]` into typed field that doesn't accept `string[]`                                                       |

**None fixed in this commit. Fix in Task 4.**

**Root cause summary:**

- `string[]` systemPrompt variant was added to the SDK in 0.3.x. The internal `SystemPromptPreset` type in `@aboardai/types` and `ExecuteOptions` need to be updated to include `string[]` and `excludeDynamicSections`.
- `ContentBlockParam` changes in the underlying Anthropic SDK (likely SearchResultBlockParam now requires `content` + `title`) affect the claude-provider prompt type.
