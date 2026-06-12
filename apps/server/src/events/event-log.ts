/**
 * EventLog — JSONL writer and reader for NormalizedEvents.
 *
 * Writer design (modeled on raw-output.jsonl in agent-executor.ts L171-188):
 * - EventLogWriter batches appended events in-memory and flushes them to disk.
 * - Normal flush: debounced 150ms after the first enqueued line.
 * - Force-flush: triggered immediately when the appended event has kind 'result'
 *   or 'error', or kind 'status' with status.status in {'interrupted', 'fatal'}.
 * - close(): flushes remaining buffer and prevents further appends.
 * - After close(), subsequent append() calls are silently dropped with a warn.
 * - Buffer RESETS after each flush; appends accumulate to the same file (appendFile).
 * - Directory created on first flush (mkdir recursive).
 *
 * Reader design:
 * - readEventLog returns [] when file is missing.
 * - Parses line-by-line; skips (with logger.warn) torn/unparseable lines and
 *   events whose v !== 1. Never throws on malformed content.
 *
 * File path options (additive generalization — feature path behavior unchanged):
 *   {projectPath, featureId} → {projectPath}/.aboardai/features/{featureId}/events.jsonl
 *   {dir}                    → {dir}/events.jsonl   (used by groups: .aboardai/groups/{id}/)
 */

import path from 'path';
import { createLogger } from '@aboardai/utils';
import { getFeatureDir } from '@aboardai/platform';
import { secureFs } from '@aboardai/platform';
import type { NormalizedEvent } from '@aboardai/types';

const logger = createLogger('EventLog');

/** Milliseconds to wait after the first enqueued line before flushing */
const DEBOUNCE_MS = 150;

/** Status values that trigger an immediate force-flush */
const FORCE_FLUSH_STATUSES = new Set(['interrupted', 'fatal']);

/** Kinds that always trigger an immediate force-flush */
const FORCE_FLUSH_KINDS = new Set<NormalizedEvent['kind']>(['result', 'error']);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function getEventsJsonlPath(projectPath: string, featureId: string): string {
  return path.join(getFeatureDir(projectPath, featureId), 'events.jsonl');
}

function isForceFlush(event: NormalizedEvent): boolean {
  if (FORCE_FLUSH_KINDS.has(event.kind)) return true;
  if (event.kind === 'status' && event.status && FORCE_FLUSH_STATUSES.has(event.status.status)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// EventLogWriter
// ---------------------------------------------------------------------------

/**
 * Options for EventLogWriter.
 *
 * Feature path (original):   { projectPath, featureId }
 * Explicit directory (new):  { dir }   — file will be {dir}/events.jsonl
 *
 * Existing code passing { projectPath, featureId } continues to work unchanged.
 */
export type EventLogWriterOptions =
  | { projectPath: string; featureId: string; dir?: never }
  | { dir: string; projectPath?: never; featureId?: never };

export class EventLogWriter {
  private readonly filePath: string;
  private buffer: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Promise tracking an in-flight flush, prevents concurrent writes */
  private flushInFlight: Promise<void> | null = null;

  constructor(opts: EventLogWriterOptions) {
    if ('dir' in opts && opts.dir !== undefined) {
      this.filePath = path.join(opts.dir, 'events.jsonl');
    } else {
      // Original { projectPath, featureId } variant — behaviour unchanged
      const { projectPath, featureId } = opts as { projectPath: string; featureId: string };
      this.filePath = getEventsJsonlPath(projectPath, featureId);
    }
  }

  /**
   * Enqueue a NormalizedEvent for writing.
   * Synchronous — schedules the debounce timer or triggers an immediate flush
   * when the event is a force-flush trigger.
   *
   * After close(): silently dropped with a warn (never throws).
   */
  append(event: NormalizedEvent): void {
    if (this.closed) {
      logger.warn(
        `[EventLog] append() called after close() — dropping event kind=${event.kind} id=${event.id}`
      );
      return;
    }

    this.buffer.push(JSON.stringify(event));

    if (isForceFlush(event)) {
      // Cancel any pending debounce and flush immediately
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.flush();
    } else if (this.debounceTimer === null) {
      // Start the debounce timer for the first enqueued line
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.flush();
      }, DEBOUNCE_MS);
    }
  }

  /**
   * Enqueue an arbitrary JSON-serialisable object for writing.
   * Used by GroupQueue to write Manifest events (not NormalizedEvent shaped).
   * Uses the same debounce path as append(); no force-flush logic applied.
   *
   * After close(): silently dropped with a warn.
   */
  appendRaw(obj: Record<string, unknown>): void {
    if (this.closed) {
      logger.warn(`[EventLog] appendRaw() called after close() — dropping object`);
      return;
    }

    this.buffer.push(JSON.stringify(obj));

    if (this.debounceTimer === null) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.flush();
      }, DEBOUNCE_MS);
    }
  }

  /**
   * Flush the current buffer to disk.
   * Resets the buffer after the flush is scheduled.
   * Non-blocking — returns immediately; actual I/O runs async.
   * Assigns the in-flight promise so close() can await it.
   */
  private flush(): void {
    if (this.buffer.length === 0) return;

    const lines = this.buffer;
    this.buffer = [];

    const data = lines.join('\n') + '\n';
    const promise = this.writeData(data);
    this.flushInFlight = promise.finally(() => {
      if (this.flushInFlight === promise) {
        this.flushInFlight = null;
      }
    });
  }

  /**
   * Wait for any in-flight flush to complete.
   * Used in tests to await force-flush writes without calling close().
   */
  async waitForFlush(): Promise<void> {
    if (this.flushInFlight !== null) {
      await this.flushInFlight;
    }
  }

  private async writeData(data: string): Promise<void> {
    try {
      await secureFs.mkdir(path.dirname(this.filePath), { recursive: true });
      await secureFs.appendFile(this.filePath, data);
    } catch (err) {
      logger.error(`[EventLog] Failed to write events.jsonl at ${this.filePath}:`, err);
    }
  }

  /**
   * Flush any remaining buffered events and prevent further appends.
   * Awaits the in-flight flush (if any) plus the final flush.
   * Safe to call multiple times (idempotent after first close).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Cancel debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Flush remaining buffer
    if (this.buffer.length > 0) {
      const lines = this.buffer;
      this.buffer = [];
      const data = lines.join('\n') + '\n';
      await this.writeData(data);
    } else if (this.flushInFlight !== null) {
      // Wait for any in-flight flush to complete
      await this.flushInFlight;
    }
  }
}

// ---------------------------------------------------------------------------
// readEventLog
// ---------------------------------------------------------------------------

/**
 * Read and parse events.jsonl for a given feature.
 * Returns [] when the file is missing.
 * Skips (with a warn) torn/unparseable lines and events whose v !== 1.
 * Never throws on malformed content.
 */
export async function readEventLog(
  projectPath: string,
  featureId: string
): Promise<NormalizedEvent[]> {
  const filePath = getEventsJsonlPath(projectPath, featureId);

  let content: string;
  try {
    // Use secureFs for path validation consistency
    content = (await secureFs.readFile(filePath, 'utf-8')) as string;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    logger.warn(`[EventLog] Failed to read events.jsonl at ${filePath}:`, err);
    return [];
  }

  const events: NormalizedEvent[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn(`[EventLog] Skipping unparseable line in ${filePath}: ${trimmed.slice(0, 80)}`);
      continue;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>)['v'] !== 1
    ) {
      logger.warn(
        `[EventLog] Skipping event with unsupported schema version in ${filePath}: v=${(parsed as Record<string, unknown>)['v']}`
      );
      continue;
    }

    events.push(parsed as NormalizedEvent);
  }

  return events;
}
