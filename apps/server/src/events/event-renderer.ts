/**
 * renderEventsToContext — converts a NormalizedEvent[] to a compact text transcript
 * suitable for inclusion in a continuation prompt.
 *
 * Rendering rules per kind:
 * - agent_message:  the raw text (concatenated, no prefix)
 * - tool_use:       "→ Tool(name): inputPreview"
 * - file_edit:      "→ Edited: path"
 * - command_run:    "→ Ran: command"
 * - question:       "→ Tool(AskUserQuestion)"
 * - task_marker:    original sentinel text ("[\TASK_START] T001", etc.)
 * - status:         "[supervisor: status]"
 * - summary:        omitted (redundant at tail; the continuation prompt gets it via feature)
 * - thinking:       omitted (content was not persisted)
 * - tool_result:    omitted (generally noise for continuation context)
 * - session:        omitted
 * - result:         "--- [Result: success/error (subtype)] ---" at the end
 * - error:          "--- [Error: message] ---" at the end
 *
 * Size cap: 30,000 characters from the TAIL (most recent content).
 * When the rendered transcript exceeds the cap, the oldest content is dropped
 * and a "[...earlier output truncated...]" prefix line is prepended.
 *
 * The function is a pure transform with no I/O — safe to unit-test directly.
 */

import type { NormalizedEvent } from '@aboardai/types';

/** Maximum characters kept in the rendered transcript (from the tail). */
export const RENDER_MAX_CHARS = 30_000;

/** Sentinel line prepended when the transcript is truncated from the head. */
export const TRUNCATION_SENTINEL = '[...earlier output truncated...]';

/**
 * Render a list of NormalizedEvents to a compact continuation context string.
 *
 * The output is capped at RENDER_MAX_CHARS characters, keeping the TAIL (most
 * recent content). When truncated, TRUNCATION_SENTINEL is prepended on its own line.
 *
 * @param events - The full event log for a feature run (from readEventLog).
 * @returns A text transcript suitable for injection into a continuation prompt.
 */
export function renderEventsToContext(events: NormalizedEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'agent_message': {
        // Emit the text verbatim — agent messages are already plain text chunks.
        // Keep them as-is so downstream marker conventions (if any residual) survive.
        const text = event.text ?? '';
        if (text.length > 0) {
          lines.push(text);
        }
        break;
      }

      case 'tool_use': {
        const name = event.tool?.name ?? '(unknown)';
        const preview = event.tool?.inputPreview;
        if (preview !== undefined && preview.length > 0) {
          lines.push(`→ Tool(${name}): ${preview}`);
        } else {
          lines.push(`→ Tool(${name})`);
        }
        break;
      }

      case 'file_edit': {
        const filePath = event.file?.path ?? '(unknown)';
        lines.push(`→ Edited: ${filePath}`);
        break;
      }

      case 'command_run': {
        const command = event.command?.command ?? '(unknown)';
        lines.push(`→ Ran: ${command}`);
        break;
      }

      case 'question': {
        // Derived from AskUserQuestion tool_use — the generic tool_use line already
        // covers it, so just emit a minimal marker here to avoid duplication.
        lines.push(`→ Tool(AskUserQuestion)`);
        break;
      }

      case 'task_marker': {
        // Reconstruct the ORIGINAL sentinel text so marker conventions are preserved
        // in the continuation prompt.
        const marker = event.marker;
        if (!marker) break;
        if (marker.type === 'task_start') {
          lines.push(`[TASK_START] ${marker.taskId ?? ''}`);
        } else if (marker.type === 'task_complete') {
          const summary = marker.summary ? `: ${marker.summary}` : '';
          lines.push(`[TASK_COMPLETE] ${marker.taskId ?? ''}${summary}`);
        } else if (marker.type === 'phase_complete') {
          lines.push(`[PHASE_COMPLETE] Phase ${marker.phase ?? ''}`);
        }
        break;
      }

      case 'status': {
        const status = event.status?.status ?? '(unknown)';
        lines.push(`[supervisor: ${status}]`);
        break;
      }

      case 'result': {
        const isError = event.result?.isError;
        const subtype = event.result?.subtype;
        const label = isError ? 'error' : 'success';
        const detail = subtype ? ` (${subtype})` : '';
        lines.push(`--- [Result: ${label}${detail}] ---`);
        break;
      }

      case 'error': {
        const msg = event.text ?? '(no message)';
        lines.push(`--- [Error: ${msg}] ---`);
        break;
      }

      // Intentionally omitted:
      // 'summary'    — added by continuation prompt machinery separately
      // 'thinking'   — content was not persisted (only thinkingChars)
      // 'tool_result'— generally noise for continuation context
      // 'session'    — internal plumbing detail
      default:
        break;
    }
  }

  const full = lines.join('\n');

  // Apply tail cap
  if (full.length <= RENDER_MAX_CHARS) {
    return full;
  }

  // Keep the tail — find a newline boundary so we don't split mid-line
  const tail = full.slice(full.length - RENDER_MAX_CHARS);
  const firstNewline = tail.indexOf('\n');
  const trimmed = firstNewline !== -1 ? tail.slice(firstNewline + 1) : tail;

  return `${TRUNCATION_SENTINEL}\n${trimmed}`;
}
