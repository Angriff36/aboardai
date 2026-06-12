/**
 * ProviderSupervisor — fault-tolerant stream supervisor
 *
 * Wraps a BaseProvider's executeQuery in retry/resume logic:
 * - Detects stalls (no message within stallTimeoutMs) and resumes with session_id
 * - Classifies thrown errors and retries retryable ones with exponential backoff
 * - Detects error result messages (is_error=true) and retries those too
 * - Handles rate-limit retry-after headers for precise delay
 * - Clears stale session IDs on "session not found" errors
 * - Respects AbortController to stop promptly
 * - Emits supervisor_status messages in-stream AND via onStatus callback
 */

import type { BaseProvider } from './base-provider.js';
import type {
  ExecuteOptions,
  ProviderMessage,
  SupervisorPolicy,
  SupervisorStatusMessage,
} from '@aboardai/types';
import { DEFAULT_SUPERVISOR_POLICY, SupervisorExhaustedError } from '@aboardai/types';
import {
  classifyError,
  classifyResultMessage,
  isStaleSessionError,
  ErrorType,
} from '../lib/error-handler.js';

export type SupervisorStatusCallback = (status: SupervisorStatusMessage) => void;

// ---------------------------------------------------------------------------
// Non-retryable error categories — emit 'fatal' and rethrow immediately
// ---------------------------------------------------------------------------
const FATAL_TYPES = new Set([
  ErrorType.AUTHENTICATION,
  ErrorType.BILLING,
  ErrorType.PERMISSION,
  ErrorType.VALIDATION,
  ErrorType.CLI_NOT_FOUND,
  ErrorType.MODEL_NOT_SUPPORTED,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SupervisorStatusMessage ProviderMessage (for in-stream yield). */
function makeStatusMsg(status: SupervisorStatusMessage): ProviderMessage {
  return status as unknown as ProviderMessage;
}

/** Promise that resolves after `ms` milliseconds (fake-timer compatible). */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a retry-after value (in seconds) from an error message.
 * Handles patterns like: "retry after 7 seconds", "retry-after: 7s", "reset in 7s"
 * Returns the delay in milliseconds, or null if not found.
 */
function parseRetryAfterMs(errorMessage: string): number | null {
  const match = /(?:retry.?after|reset.*?)\s*(\d+)\s*s/i.exec(errorMessage);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }
  return null;
}

/** Calculate exponential backoff delay for an attempt (1-indexed). */
function calcBackoffMs(attempt: number, policy: SupervisorPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attempt - 1));
}

/**
 * Create a promise that rejects when the abort signal fires (or immediately if already aborted).
 * Returns [promise, cleanup] — call cleanup() to remove the event listener.
 */
function createAbortPromise(signal: AbortSignal): [Promise<never>, () => void] {
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('__ABORT__'));
      return;
    }
    const handler = () => reject(new Error('__ABORT__'));
    signal.addEventListener('abort', handler, { once: true });
    cleanup = () => signal.removeEventListener('abort', handler);
  });
  return [promise, cleanup];
}

/**
 * Sleep for `ms` ms but stop early if the abort signal fires.
 * Returns true if completed normally, false if aborted.
 */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
  const [abortPromise, cleanup] = createAbortPromise(signal);
  try {
    await Promise.race([sleep(ms), abortPromise]);
    cleanup();
    return true;
  } catch (e) {
    cleanup();
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === '__ABORT__') return false;
    throw e;
  }
}

// Sentinel error types for flow control
const STALL_ERR = '__STALL__';
const ABORT_ERR = '__ABORT__';

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Supervise a provider query with fault-tolerance.
 */
export async function* superviseQuery(
  provider: BaseProvider,
  options: ExecuteOptions,
  policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
  onStatus?: SupervisorStatusCallback
): AsyncGenerator<ProviderMessage> {
  /** Emit a status event both in-stream and via callback. */
  function* emitStatus(msg: SupervisorStatusMessage): Generator<ProviderMessage> {
    onStatus?.(msg);
    yield makeStatusMsg(msg);
  }

  const signal = options.abortController?.signal;

  // Emit 'started' once
  yield* emitStatus({ type: 'supervisor_status', status: 'started' });

  let capturedSessionId: string | undefined = options.sdkSessionId;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < policy.maxAttempts) {
    attempt++;

    // Check abort at the top of each attempt
    if (signal?.aborted) return;

    // Build options for this attempt (thread session_id on retries)
    const attemptOptions: ExecuteOptions = {
      ...options,
      sdkSessionId: capturedSessionId,
    };

    const iterator = provider.executeQuery(attemptOptions);

    /** Indicates why this attempt ended without completing cleanly */
    type AttemptOutcome = 'stalled' | 'thrown' | 'error_result' | 'completed';
    let outcome: AttemptOutcome = 'completed';
    let attemptError: unknown;

    try {
      // Drain the generator message by message, racing against stall timer
      messageLoop: while (true) {
        // Check abort before waiting
        if (signal?.aborted) {
          iterator.return?.();
          return;
        }

        // Set up stall timer
        let stallTimerId: ReturnType<typeof setTimeout> | null = null;
        let stallRejectFn: ((e: Error) => void) | null = null;
        const stallPromise = new Promise<never>((_resolve, reject) => {
          stallRejectFn = reject;
          stallTimerId = setTimeout(() => {
            reject(new Error(STALL_ERR));
          }, policy.stallTimeoutMs);
        });

        // Set up abort promise
        let abortCleanup: () => void = () => {};
        let abortPromise: Promise<never> = new Promise<never>(() => {}); // never resolves
        if (signal) {
          const [ap, cleanup] = createAbortPromise(signal);
          abortPromise = ap;
          abortCleanup = cleanup;
        }

        let iterResult: IteratorResult<ProviderMessage>;
        try {
          iterResult = await Promise.race([iterator.next(), stallPromise, abortPromise]);
        } catch (raceErr: unknown) {
          const msg = raceErr instanceof Error ? raceErr.message : String(raceErr);
          if (msg === ABORT_ERR) {
            // Abort fired — clean up and stop immediately (don't await return)
            if (stallTimerId !== null) clearTimeout(stallTimerId);
            abortCleanup();
            // Fire-and-forget: don't await, since the iterator may be stuck awaiting a sleep
            iterator.return?.();
            return;
          }
          if (msg === STALL_ERR) {
            // Stall detected — fire-and-forget cleanup (stuck in sleep)
            abortCleanup();
            iterator.return?.();
            outcome = 'stalled';
            break messageLoop;
          }
          // Real iterator error
          if (stallTimerId !== null) clearTimeout(stallTimerId);
          abortCleanup();
          throw raceErr;
        }

        // Message or done — clear stall timer
        if (stallTimerId !== null) clearTimeout(stallTimerId);
        abortCleanup();

        if (iterResult.done) {
          // Generator completed normally
          outcome = 'completed';
          break messageLoop;
        }

        const msg = iterResult.value;

        // Capture session_id (first occurrence wins, later updates allowed for same stream)
        if (msg.session_id) {
          capturedSessionId = msg.session_id;
        }

        // Check for error result message (S10)
        const resultClassification = classifyResultMessage(msg);
        if (resultClassification !== null) {
          // Error result — treat as a failed attempt; don't forward to consumer
          attemptError = new Error(
            `result error: api_error_status=${(msg as any).api_error_status ?? 'unknown'}`
          );

          if (FATAL_TYPES.has(resultClassification.type)) {
            await iterator.return?.();
            yield* emitStatus({ type: 'supervisor_status', status: 'fatal', attempt });
            throw attemptError;
          }

          // Retryable error result
          await iterator.return?.();
          outcome = 'error_result';
          lastError = attemptError;
          break messageLoop;
        }

        // Normal message — forward to consumer
        yield msg;
      }
    } catch (err: unknown) {
      // Iterator threw an error
      outcome = 'thrown';
      attemptError = err;
      lastError = err;

      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }

      const errMsg = err instanceof Error ? err.message : String(err);

      // Abort check
      if (errMsg === ABORT_ERR || signal?.aborted) return;

      const classification = classifyError(err);

      // Fatal types — rethrow immediately
      if (FATAL_TYPES.has(classification.type)) {
        yield* emitStatus({ type: 'supervisor_status', status: 'fatal', attempt });
        throw err;
      }

      // Stale session — clear session id
      if (capturedSessionId && isStaleSessionError(errMsg)) {
        capturedSessionId = undefined;
      }
    }

    // --- Handle attempt outcome ---

    if (outcome === 'completed') {
      // Happy path or final successful retry — done
      return;
    }

    // Determine retry eligibility
    if (attempt >= policy.maxAttempts) {
      // No more attempts
      break;
    }

    // We have more attempts — determine delay strategy
    const errForClassify = attemptError ?? lastError;
    const classification = errForClassify !== undefined ? classifyError(errForClassify) : null;

    if (outcome === 'stalled') {
      // Emit stalled/resumed pair
      yield* emitStatus({ type: 'supervisor_status', status: 'stalled', attempt });

      // Stall: no backoff delay, just resume immediately
      yield* emitStatus({ type: 'supervisor_status', status: 'resumed', attempt: attempt + 1 });

      // No sleep needed for stall resume
    } else if (outcome === 'thrown' || outcome === 'error_result') {
      if (!classification || !classification.retryable) {
        // Non-retryable (and not fatal — those already threw above) — exhaust
        break;
      }

      if (classification.type === ErrorType.RATE_LIMIT) {
        // Rate limit: parse retry-after or use backoff
        const errMsg =
          errForClassify instanceof Error ? errForClassify.message : String(errForClassify ?? '');
        const retryAfterMs = parseRetryAfterMs(errMsg) ?? calcBackoffMs(attempt, policy);

        yield* emitStatus({
          type: 'supervisor_status',
          status: 'rate_limited',
          attempt,
          retryAfterMs,
        });

        const completed = await sleepAbortable(retryAfterMs, signal);
        if (!completed) return;
      } else {
        // Network/server/unknown retryable
        yield* emitStatus({ type: 'supervisor_status', status: 'reconnecting', attempt });

        const delayMs = calcBackoffMs(attempt, policy);
        const completed = await sleepAbortable(delayMs, signal);
        if (!completed) return;
      }
    }

    // Continue to next attempt
    lastError = attemptError ?? lastError;
  }

  // Exhausted all attempts
  const finalClassification =
    lastError !== undefined ? classifyError(lastError) : { type: ErrorType.UNKNOWN };
  yield* emitStatus({ type: 'supervisor_status', status: 'interrupted', attempt });
  throw new SupervisorExhaustedError(
    `ProviderSupervisor exhausted after ${attempt} attempt(s)`,
    finalClassification.type,
    attempt,
    lastError
  );
}
