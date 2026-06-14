/**
 * Normalized event types for AboardAI event pipeline
 *
 * Maps all provider messages to a common, typed event stream.
 * Handlers can filter by kind and access type-safe payload fields.
 */

export type NormalizedEventKind =
  | 'agent_message' // text content from assistant
  | 'thinking' // thinking block (content elided to length only by default)
  | 'tool_use' // any tool invocation (raw name + input summary)
  | 'tool_result' // tool result (truncated content)
  | 'file_edit' // derived: Edit/Write/MultiEdit/NotebookEdit tool_use (path extracted)
  | 'command_run' // derived: Bash tool_use (command extracted)
  | 'question' // derived: AskUserQuestion tool_use
  | 'task_marker' // [TASK_START]/[TASK_COMPLETE]/[PHASE_COMPLETE] detected in streamed text
  | 'summary' // <summary>/## Summary extracted at stream end
  | 'status' // supervisor_status passthrough (stalled/reconnecting/resumed/...)
  | 'session' // session_id observed/changed
  | 'error' // error message or error-result
  | 'result'; // terminal result (subtype, success/error)

/** A simple replacement-hunk diff for a single edit (old lines removed, new lines added). */
export interface FileDiff {
  unified: string; // hunk text: removed lines prefixed '- ', added lines prefixed '+ '
  adds: number; // number of added lines
  dels: number; // number of removed lines
  truncated: boolean; // true if `unified` was capped
}

export interface NormalizedEvent {
  v: 1; // schema version
  id: string; // monotonic per-stream: `${seq}` zero-padded
  ts: string; // ISO timestamp
  kind: NormalizedEventKind;
  provider: string; // provider name ('claude', 'codex', ...)
  featureId?: string;
  // kind-specific payload (one of):
  text?: string; // agent_message (chunk), summary, error, thinking (when persisted)
  tool?: { name: string; inputPreview?: string; toolUseId?: string };
  file?: { path: string; tool: string; diff?: FileDiff };
  command?: { command: string };
  marker?: {
    type: 'task_start' | 'task_complete' | 'phase_complete';
    taskId?: string;
    phase?: number;
    summary?: string;
  };
  status?: { status: string; attempt?: number; retryAfterMs?: number; detail?: string };
  sessionId?: string;
  result?: { subtype?: string; isError: boolean };
  thinkingChars?: number; // thinking: length only (content not persisted by default)
  toolUseId?: string; // tool_result: id of the tool_use this result belongs to (correlation)
  thinkingTruncated?: boolean; // thinking: true if persisted 'text' was capped
  textTruncated?: boolean; // tool_result: true if `text` was capped
}
