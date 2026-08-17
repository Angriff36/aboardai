/**
 * NormalizedEventStream — maps every streamed ProviderMessage to typed NormalizedEvents.
 *
 * Design:
 * - One instance per agent run (SESSION-SLICE SEMANTICS: construct fresh per run, never feed
 *   pre-existing previousContent from continuation runs).
 * - feed(msg) processes one ProviderMessage at a time and returns 0..N NormalizedEvents.
 * - finalize() scans the accumulated text buffer for a summary and returns a summary event
 *   if one is found.
 * - Marker detection operates over an accumulated text buffer so markers split across chunk
 *   boundaries are reassembled correctly. Fired markers are deduplicated by (type+taskId/phase).
 * - For tool_use blocks the generic tool_use event is emitted BEFORE any derived event
 *   (file_edit / command_run / question).
 */

import type { NormalizedEvent, NormalizedEventKind } from '@aboardai/types';
import type { ProviderMessage, ContentBlock } from '@aboardai/types';
import {
  detectAllTaskStartMarkers,
  detectAllTaskCompleteMarkers,
  detectAllPhaseCompleteMarkers,
  extractSummary,
} from '../services/spec-parser.js';
import { buildDiff } from './diff-builder.js';

const TOOL_RESULT_MAX_CHARS = 4000;
const THINKING_MAX_CHARS = 4000;

// Tool names that derive file_edit events
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tool names that derive command_run events
const COMMAND_RUN_TOOLS = new Set(['Bash']);
// Tool names that derive question events
const QUESTION_TOOLS = new Set(['AskUserQuestion']);

// Error subtypes that indicate an error result
const ERROR_SUBTYPES = new Set([
  'error',
  'error_max_turns',
  'error_max_structured_output_retries',
  'error_during_execution',
  'error_max_budget_usd',
]);

export interface NormalizedEventStreamOptions {
  provider: string;
  featureId?: string;
  /** Optionally override the clock for deterministic testing */
  clock?: () => string;
}

/**
 * A stateful normalizer for one agent execution run.
 * Create a fresh instance per run; never reuse across continuation runs.
 */
export class NormalizedEventStream {
  private readonly provider: string;
  private readonly featureId: string | undefined;
  private readonly clock: () => string;

  /** Monotonic counter — incremented before each event is emitted */
  private seq = 0;

  /** Last observed session_id — used to emit session events on first-see and changes */
  private lastSessionId: string | undefined = undefined;

  /** Accumulated text buffer for marker scanning (session-slice only) */
  private textBuffer = '';

  /** Dedup set: `"task_start:T001"`, `"task_complete:T001"`, `"phase_complete:2"` */
  private firedMarkers = new Set<string>();

  constructor({ provider, featureId, clock }: NormalizedEventStreamOptions) {
    this.provider = provider;
    this.featureId = featureId;
    this.clock = clock ?? (() => new Date().toISOString());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process one ProviderMessage. Returns 0..N NormalizedEvents.
   */
  feed(msg: ProviderMessage): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    // --- session_id change detection ---
    if (msg.session_id !== undefined && msg.session_id !== this.lastSessionId) {
      this.lastSessionId = msg.session_id;
      events.push(this.make('session', { sessionId: msg.session_id }));
    }

    switch (msg.type) {
      case 'assistant':
        events.push(...this.processAssistant(msg));
        break;

      case 'user':
        events.push(...this.processUser(msg));
        break;

      case 'error':
        if (msg.error) {
          events.push(this.make('error', { text: msg.error }));
        }
        break;

      case 'result': {
        const isError = msg.subtype !== undefined && ERROR_SUBTYPES.has(msg.subtype);
        events.push(
          this.make('result', {
            result: { subtype: msg.subtype, isError },
          })
        );
        break;
      }

      case 'supervisor_status': {
        // msg as SupervisorStatusMessage — cast via unknown for TS safety
        const ss = msg as unknown as {
          status: string;
          attempt?: number;
          retryAfterMs?: number;
          detail?: string;
        };
        events.push(
          this.make('status', {
            status: {
              status: ss.status,
              attempt: ss.attempt,
              retryAfterMs: ss.retryAfterMs,
              detail: ss.detail,
            },
          })
        );
        break;
      }
    }

    return events;
  }

  /**
   * Called when the stream ends. Scans the accumulated text buffer for a summary
   * (session-slice semantics — the buffer covers exactly this run's text output).
   * Returns a summary event if one is found; otherwise returns [].
   */
  finalize(): NormalizedEvent[] {
    const summary = extractSummary(this.textBuffer);
    if (summary) {
      return [this.make('summary', { text: summary })];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private processAssistant(msg: ProviderMessage): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const blocks: ContentBlock[] = msg.message?.content ?? [];

    for (const block of blocks) {
      events.push(...this.processBlock(block));
    }

    return events;
  }

  private processUser(msg: ProviderMessage): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const blocks: ContentBlock[] = msg.message?.content ?? [];

    for (const block of blocks) {
      if (block.type === 'tool_result') {
        events.push(this.toolResultEvent(block.content ?? '', block.tool_use_id));
      }
    }

    return events;
  }

  private processBlock(block: ContentBlock): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    switch (block.type) {
      case 'text': {
        const text = block.text ?? '';
        events.push(this.make('agent_message', { text }));

        // Accumulate into text buffer and scan for newly completed markers
        this.textBuffer += text;
        events.push(...this.scanForNewMarkers());
        break;
      }

      case 'thinking': {
        const full = block.thinking ?? '';
        const truncated = full.length > THINKING_MAX_CHARS;
        const text = truncated ? full.substring(0, THINKING_MAX_CHARS) + '…' : full;
        events.push(
          this.make('thinking', { thinkingChars: full.length, text, thinkingTruncated: truncated })
        );
        break;
      }

      case 'tool_use': {
        const name = block.name ?? '';
        const inputPreview = this.previewInput(block.input);

        // Generic tool_use FIRST
        events.push(
          this.make('tool_use', {
            tool: { name, inputPreview, toolUseId: block.tool_use_id },
          })
        );

        // Derived events SECOND
        if (FILE_EDIT_TOOLS.has(name)) {
          const filePath = this.extractFilePath(block.input);
          if (filePath) {
            const diff = buildDiff(block.input, name);
            events.push(this.make('file_edit', { file: { path: filePath, tool: name, diff } }));
          }
        } else if (COMMAND_RUN_TOOLS.has(name)) {
          const command = this.extractCommand(block.input);
          if (command !== undefined) {
            events.push(this.make('command_run', { command: { command } }));
          }
        } else if (QUESTION_TOOLS.has(name)) {
          events.push(this.make('question', {}));
        }
        break;
      }

      case 'tool_result': {
        // tool_result blocks inside assistant messages (e.g. cursor completed events)
        events.push(this.toolResultEvent(block.content ?? '', block.tool_use_id));
        break;
      }
    }

    return events;
  }

  /**
   * Scan the current text buffer for ANY marker occurrences and emit events for
   * those not yet fired (dedup by key). Returns newly-fired marker events.
   *
   * Strategy: scan the WHOLE accumulated buffer each time, skip already-fired keys.
   * This is safe because the dedup set prevents re-emission, and it handles markers
   * that were split across chunk boundaries (they only become detectable once their
   * tail chunk is appended to the buffer).
   */
  private scanForNewMarkers(): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    // TASK_START
    for (const { taskId } of detectAllTaskStartMarkers(this.textBuffer)) {
      const key = `task_start:${taskId}`;
      if (!this.firedMarkers.has(key)) {
        this.firedMarkers.add(key);
        events.push(
          this.make('task_marker', {
            marker: { type: 'task_start', taskId },
          })
        );
      }
    }

    // TASK_COMPLETE
    for (const { taskId, summary } of detectAllTaskCompleteMarkers(this.textBuffer)) {
      const key = `task_complete:${taskId}`;
      if (!this.firedMarkers.has(key)) {
        this.firedMarkers.add(key);
        events.push(
          this.make('task_marker', {
            marker: { type: 'task_complete', taskId, summary },
          })
        );
      }
    }

    // PHASE_COMPLETE
    for (const { phase } of detectAllPhaseCompleteMarkers(this.textBuffer)) {
      const key = `phase_complete:${phase}`;
      if (!this.firedMarkers.has(key)) {
        this.firedMarkers.add(key);
        events.push(
          this.make('task_marker', {
            marker: { type: 'phase_complete', phase },
          })
        );
      }
    }

    return events;
  }

  /** Construct a NormalizedEvent with the next monotonic id */
  private make(kind: NormalizedEventKind, payload: Partial<NormalizedEvent>): NormalizedEvent {
    const id = String(++this.seq).padStart(4, '0');
    return {
      v: 1,
      id,
      ts: this.clock(),
      kind,
      provider: this.provider,
      featureId: this.featureId,
      ...payload,
    };
  }

  /** Build a tool_result event with 4k cap, textTruncated flag, and toolUseId correlation */
  private toolResultEvent(raw: string | ContentBlock[], toolUseId?: string): NormalizedEvent {
    const flat = this.flattenContent(raw);
    const truncated = flat.length > TOOL_RESULT_MAX_CHARS;
    const text = truncated ? flat.substring(0, TOOL_RESULT_MAX_CHARS) + '…' : flat;
    return this.make('tool_result', { text, textTruncated: truncated, toolUseId });
  }

  /**
   * Coerce tool_result content to a string. The Anthropic/Claude SDK delivers
   * tool_result content as either a plain string OR an array of nested content
   * blocks ([{type:'text', text:'...'}], image blocks, etc.). Passing the array
   * form straight through to a NormalizedEvent.text makes React try to render an
   * object child → "React error #31". Flatten text blocks; describe non-text ones.
   */
  private flattenContent(raw: string | ContentBlock[] | undefined): string {
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'string') return raw;
    if (!Array.isArray(raw)) return String(raw);
    return raw
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          if (typeof block.text === 'string') return block.text;
          return `[${block.type ?? 'content'}]`;
        }
        return String(block);
      })
      .join('\n');
  }

  /** Truncate tool input to a short preview string */
  private previewInput(input: unknown): string | undefined {
    if (input === undefined || input === null) return undefined;
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return str.length > 200 ? str.substring(0, 200) + '…' : str;
  }

  /** Extract file_path from tool input object */
  private extractFilePath(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    const fp = obj['file_path'] ?? obj['path'];
    return typeof fp === 'string' ? fp : undefined;
  }

  /** Extract command string from tool input object */
  private extractCommand(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    const cmd = obj['command'];
    return typeof cmd === 'string' ? cmd : undefined;
  }
}
