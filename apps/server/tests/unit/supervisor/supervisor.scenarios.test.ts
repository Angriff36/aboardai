/**
 * ProviderSupervisor Fault-Injection Harness — S1–S10
 *
 * All 10 scenarios are deliberately RED until Task 3 implements
 * superviseQuery() in apps/server/src/providers/provider-supervisor.ts.
 *
 * The import is a normal top-level import of the PLACEHOLDER module.
 * The placeholder throws 'not implemented' at runtime but does NOT crash
 * at import time, so the test suite loads cleanly and each scenario fails
 * with an assertion error (or 'not implemented' propagation) rather than a
 * module-resolution/setup crash.
 *
 * Fake-timer notes:
 * - vi.useFakeTimers() is activated per-test via beforeEach/afterEach so
 *   stall and rate-limit delays are controlled by advanceTimersByTimeAsync().
 * - sleep() in FakeProvider is setTimeout-based, so fake timers drive it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderMessage, SupervisorPolicy, SupervisorStatusMessage } from '@aboardai/types';
import { SupervisorExhaustedError } from '@aboardai/types';
import { superviseQuery } from '@/providers/provider-supervisor.js';
import { FakeProvider } from './fake-provider.js';
import type { FakeRun } from './fake-provider.js';

// ---------------------------------------------------------------------------
// Small test policy — keeps fake-timer numbers manageable
// ---------------------------------------------------------------------------

const TEST_POLICY: SupervisorPolicy = {
  stallTimeoutMs: 5_000,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple text ProviderMessage. */
function textMsg(text: string, sessionId?: string): ProviderMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/** Build an init-like system ProviderMessage carrying a session_id. */
function initMsg(sessionId: string): ProviderMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[init]' }],
    },
  };
}

/** Build a success result ProviderMessage. */
function resultMsg(sessionId?: string): ProviderMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: 'done',
  };
}

/** Build an error_during_execution result ProviderMessage. */
function resultErrorMsg(apiErrorStatus: number, sessionId?: string): ProviderMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    api_error_status: apiErrorStatus,
  } as ProviderMessage & { is_error: boolean; api_error_status: number };
}

/**
 * Collect all messages from an AsyncGenerator, with optional fake-timer
 * advancement interleaved. Returns [messages[], thrownError | undefined].
 */
async function collectMessages(
  gen: AsyncGenerator<ProviderMessage>,
  advanceMs?: number
): Promise<{ messages: ProviderMessage[]; error?: unknown }> {
  const messages: ProviderMessage[] = [];
  try {
    if (advanceMs !== undefined) {
      // Interleave: kick off the generator and advance timers concurrently
      const iterate = async () => {
        for await (const msg of gen) {
          messages.push(msg);
        }
      };
      const iteratePromise = iterate();
      await vi.advanceTimersByTimeAsync(advanceMs);
      await iteratePromise;
    } else {
      for await (const msg of gen) {
        messages.push(msg);
      }
    }
  } catch (e: unknown) {
    return { messages, error: e };
  }
  return { messages };
}

/**
 * Collect messages advancing fake timers in small increments while iterating.
 * Useful when stalls/delays gate progress and we want to advance past them.
 */
async function collectWithFakeTimers(
  gen: AsyncGenerator<ProviderMessage>,
  stepMs: number,
  maxSteps: number
): Promise<{ messages: ProviderMessage[]; error?: unknown }> {
  const messages: ProviderMessage[] = [];
  let error: unknown;
  let done = false;

  const iterate = async () => {
    try {
      for await (const msg of gen) {
        messages.push(msg);
      }
    } catch (e) {
      error = e;
    } finally {
      done = true;
    }
  };

  const iteratePromise = iterate();

  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
    // Yield control to let microtasks/promises progress
    await Promise.resolve();
  }

  await iteratePromise;
  return { messages, error };
}

/** Extract supervisor_status messages from a collected message array. */
function statusMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.filter((m) => m.type === 'supervisor_status');
}

/** Extract data (non-supervisor_status) messages. */
function dataMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.filter((m) => m.type !== 'supervisor_status');
}

/** Check a status message has the expected status string. */
function hasStatus(messages: ProviderMessage[], status: string): boolean {
  return messages.some((m) => m.type === 'supervisor_status' && (m as any).status === status);
}

// ---------------------------------------------------------------------------
// Default ExecuteOptions
// ---------------------------------------------------------------------------

function defaultOptions(
  overrides: Partial<import('@aboardai/types').ExecuteOptions> = {}
): import('@aboardai/types').ExecuteOptions {
  return {
    prompt: 'test prompt',
    model: 'fake-model-1',
    cwd: '/tmp/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario tests — all expected to be RED until superviseQuery is implemented
// ---------------------------------------------------------------------------

describe('ProviderSupervisor scenarios (S1–S10) [RED — not implemented]', () => {
  let statusCallbackEvents: SupervisorStatusMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    statusCallbackEvents = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const onStatus = (s: SupervisorStatusMessage) => {
    statusCallbackEvents.push(s);
  };

  // -------------------------------------------------------------------------
  // S1 — Stall mid-stream
  // -------------------------------------------------------------------------
  it('S1: stall mid-stream → abort run, resume with session_id, splice continuation into same stream', async () => {
    const SESSION_ID = 'sess-1';

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: initMsg(SESSION_ID) },
        { kind: 'message', message: textMsg('msg-2', SESSION_ID) },
        // Stall longer than policy.stallTimeoutMs
        { kind: 'stall', ms: TEST_POLICY.stallTimeoutMs + 2_000 },
        { kind: 'end' },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('resumed-msg-3', SESSION_ID) },
        { kind: 'message', message: resultMsg(SESSION_ID) },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 1_000, 20);

    // No error should propagate to consumer
    expect(error).toBeUndefined();

    // The 2nd executeQuery call must have received sdkSessionId from the first run's init msg
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(2);
    const secondOptions = provider.getRecordedOptionsForRun(1);
    expect(secondOptions?.sdkSessionId).toBe(SESSION_ID);

    // Continuation messages should appear in the SAME output stream (spliced)
    const data = dataMessages(messages);
    const texts = data
      .filter((m) => m.message?.content?.[0]?.text)
      .map((m) => m.message?.content?.[0]?.text);
    expect(texts).toContain('resumed-msg-3');

    // Status events: 'stalled' then 'resumed' must appear in-stream or callback
    const allStatus = [...statusMessages(messages), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'stalled')).toBe(true);
    expect(allStatus.some((s) => (s as any).status === 'resumed')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // S2 — Network disconnect
  // -------------------------------------------------------------------------
  it('S2: network disconnect → classified NETWORK, backoff, resumed with session_id', async () => {
    const SESSION_ID = 'sess-2';

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: initMsg(SESSION_ID) },
        { kind: 'message', message: textMsg('msg-2') },
        { kind: 'throw', error: new Error('ECONNRESET: connection reset') },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('resumed-after-disconnect') },
        { kind: 'message', message: resultMsg(SESSION_ID) },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    // Advance enough for the backoff delay to expire
    const { messages, error } = await collectWithFakeTimers(gen, 200, 30);

    expect(error).toBeUndefined();

    // Should have been retried
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(2);

    // 2nd call should carry the session_id
    const secondOptions = provider.getRecordedOptionsForRun(1);
    expect(secondOptions?.sdkSessionId).toBe(SESSION_ID);

    // 'reconnecting' status emitted in-stream or via callback
    const allStatus = [...statusMessages(messages), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'reconnecting')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // S3 — Rate limit with retry-after
  // -------------------------------------------------------------------------
  it('S3: rate limit → waits ≥7000ms before retry; status rate_limited with retryAfterMs≈7000', async () => {
    const RETRY_AFTER_MS = 7_000;

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('msg-1') },
        { kind: 'throw', error: new Error('429 rate limit exceeded, retry after 7 seconds') },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('after-rate-limit') },
        { kind: 'message', message: resultMsg() },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    let callCountBeforeAdvance: number | undefined;

    // Start iteration
    const iteratePromise = (async () => {
      const msgs: ProviderMessage[] = [];
      let error: unknown;
      try {
        for await (const msg of gen) {
          msgs.push(msg);
          // After receiving first message and the throw, record call count
          // before timers advance
          if (provider.getCallCount() === 1) {
            callCountBeforeAdvance = provider.getCallCount();
          }
        }
      } catch (e) {
        error = e;
      }
      return { msgs, error };
    })();

    // Advance just under 7 seconds — supervisor should NOT have retried yet
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 500);
    await Promise.resolve();
    const callCountBeforeRetry = provider.getCallCount();

    // Now advance past 7 seconds
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();

    const { msgs, error } = await iteratePromise;

    expect(error).toBeUndefined();

    // Retry should NOT have happened before 7s elapsed
    expect(callCountBeforeRetry).toBe(1);

    // Eventually retried
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(2);

    // Rate-limited status emitted with retryAfterMs ≈ 7000
    const allStatus = [...statusMessages(msgs), ...statusCallbackEvents];
    const rateLimitedEvent = allStatus.find((s) => (s as any).status === 'rate_limited');
    expect(rateLimitedEvent).toBeDefined();
    expect((rateLimitedEvent as any)?.retryAfterMs).toBeGreaterThanOrEqual(RETRY_AFTER_MS - 500);
    expect((rateLimitedEvent as any)?.retryAfterMs).toBeLessThanOrEqual(RETRY_AFTER_MS + 500);
  });

  // -------------------------------------------------------------------------
  // S4 — Auth failure — no retry
  // -------------------------------------------------------------------------
  it('S4: auth failure → no retry; status fatal; error rethrown to consumer', async () => {
    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('msg-1') },
        { kind: 'throw', error: new Error('401 unauthorized: invalid api key') },
      ],
    };

    const provider = new FakeProvider([run0]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 100, 10);

    // Error must be rethrown to consumer
    expect(error).toBeDefined();

    // executeQuery called exactly once — no retry
    expect(provider.getCallCount()).toBe(1);

    // 'fatal' status emitted
    const allStatus = [...statusMessages(messages), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'fatal')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // S5 — Crash then resume — consumer receives both runs' messages in order
  // -------------------------------------------------------------------------
  it('S5: crash mid-stream then resume → consumer receives all messages in order, no duplicates', async () => {
    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('r0-m1') },
        { kind: 'message', message: textMsg('r0-m2') },
        { kind: 'message', message: textMsg('r0-m3') },
        { kind: 'throw', error: new Error('500 internal server error') },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('r1-m1') },
        { kind: 'message', message: textMsg('r1-m2') },
        { kind: 'message', message: resultMsg() },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 200, 20);

    expect(error).toBeUndefined();

    // Extract text messages in order
    const data = dataMessages(messages);
    const texts = data
      .filter((m) => m.message?.content?.[0]?.text)
      .map((m) => m.message?.content?.[0]?.text);

    // run0's 3 msgs appear before run1's 2 msgs
    expect(texts.indexOf('r0-m1')).toBeLessThan(texts.indexOf('r0-m2'));
    expect(texts.indexOf('r0-m2')).toBeLessThan(texts.indexOf('r0-m3'));
    expect(texts.indexOf('r0-m3')).toBeLessThan(texts.indexOf('r1-m1'));
    expect(texts.indexOf('r1-m1')).toBeLessThan(texts.indexOf('r1-m2'));

    // No duplicates
    const unique = new Set(texts);
    expect(unique.size).toBe(texts.length);

    // Result message present
    expect(data.some((m) => m.type === 'result')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // S6 — Exhausted retries
  // -------------------------------------------------------------------------
  it('S6: all attempts exhausted → SupervisorExhaustedError with attempts+classification; status interrupted', async () => {
    // Each run throws a network-ish error after one message
    const makeRun = (): FakeRun => ({
      directives: [
        { kind: 'message', message: textMsg('partial') },
        { kind: 'throw', error: new Error('ECONNRESET: connection reset') },
      ],
    });

    // Provide exactly maxAttempts runs
    const provider = new FakeProvider(Array.from({ length: TEST_POLICY.maxAttempts }, makeRun));
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 500, 30);

    // SupervisorExhaustedError must be thrown
    expect(error).toBeInstanceOf(SupervisorExhaustedError);
    const exhausted = error as SupervisorExhaustedError;
    expect(exhausted.attempts).toBe(TEST_POLICY.maxAttempts);
    expect(exhausted.classification).toBeDefined();

    // Status 'interrupted' emitted (NOT 'fatal')
    const allStatus = [...statusMessages(messages), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'interrupted')).toBe(true);
    expect(allStatus.some((s) => (s as any).status === 'fatal')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // S7 — Stale session detection
  // -------------------------------------------------------------------------
  it('S7: stale session → 3rd call receives sdkSessionId === undefined (cleared)', async () => {
    const SESSION_ID = 'sess-7';

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: initMsg(SESSION_ID) },
        { kind: 'throw', error: new Error('ECONNRESET: connection reset') },
      ],
    };

    // run1: immediately throw stale-session error
    const run1: FakeRun = {
      directives: [{ kind: 'throw', error: new Error('session not found') }],
    };

    // run2: fresh start succeeds
    const run2: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('fresh-start') },
        { kind: 'message', message: resultMsg() },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1, run2]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 200, 30);

    expect(error).toBeUndefined();

    // 3 calls were made
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(3);

    // 3rd call must NOT carry the old session_id
    const thirdOptions = provider.getRecordedOptionsForRun(2);
    expect(thirdOptions?.sdkSessionId).toBeUndefined();

    // Stream completed with fresh messages
    const data = dataMessages(messages);
    expect(data.some((m) => m.type === 'result')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // S8 — Abort respected during stall
  // -------------------------------------------------------------------------
  it('S8: abort during stall → supervisor stops promptly, no further executeQuery calls', async () => {
    const abortController = new AbortController();

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('msg-1') },
        { kind: 'stall', ms: 60_000 }, // very long stall
      ],
    };

    const provider = new FakeProvider([run0]);
    const gen = superviseQuery(
      provider,
      defaultOptions({ abortController }),
      TEST_POLICY,
      onStatus
    );

    let genDone = false;
    let genError: unknown;
    const msgs: ProviderMessage[] = [];

    const iteratePromise = (async () => {
      try {
        for await (const msg of gen) {
          msgs.push(msg);
        }
      } catch (e) {
        genError = e;
      } finally {
        genDone = true;
      }
    })();

    // Advance a bit so the first message is emitted, stall begins
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    // Abort during the stall
    abortController.abort();

    // Advance timers a little more to let abort propagate
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    // The generator should have ended (done or thrown)
    await iteratePromise;

    expect(genDone).toBe(true);

    // No further executeQuery calls after abort
    expect(provider.getCallCount()).toBe(1);

    // No retry status events (reconnecting/resumed)
    const allStatus = [...statusMessages(msgs), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'reconnecting')).toBe(false);
    expect(allStatus.some((s) => (s as any).status === 'resumed')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // S9 — Happy path untouched
  // -------------------------------------------------------------------------
  it('S9: happy path → output messages identical to input; executeQuery called exactly once', async () => {
    const dataMessagesIn: ProviderMessage[] = [
      textMsg('a'),
      textMsg('b'),
      textMsg('c'),
      textMsg('d'),
      resultMsg(),
    ];

    const run0: FakeRun = {
      directives: [
        ...dataMessagesIn.map((message) => ({ kind: 'message' as const, message })),
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectMessages(gen);

    expect(error).toBeUndefined();

    // executeQuery called exactly once
    expect(provider.getCallCount()).toBe(1);

    // Data messages byte-equal in order (supervisor_status extras allowed)
    const data = dataMessages(messages);
    expect(data).toEqual(dataMessagesIn);
  });

  // -------------------------------------------------------------------------
  // S10 — Result subtype error_during_execution with api_error_status 529
  // -------------------------------------------------------------------------
  it('S10: result subtype error_during_execution api_error_status 529 → supervisor retries (SERVER/retryable); clean final result', async () => {
    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('r0-m1') },
        // Error result message — supervisor must detect this as a failure
        { kind: 'message', message: resultErrorMsg(529) },
        { kind: 'end' },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('r1-m1') },
        { kind: 'message', message: resultMsg() },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    const { messages, error } = await collectWithFakeTimers(gen, 200, 20);

    expect(error).toBeUndefined();

    // 529 is retryable (SERVER_ERROR) → supervisor must retry
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(2);

    // Consumer sees clean final result (not an error result)
    const data = dataMessages(messages);
    const finalResult = data.findLast((m) => m.type === 'result');
    expect(finalResult).toBeDefined();
    expect(finalResult?.subtype).toBe('success');
  });

  // -------------------------------------------------------------------------
  // S11 — Early consumer return (for-await break) → full cleanup
  // -------------------------------------------------------------------------
  it('S11: consumer breaks out of for-await → inner iterator closed, stall timer cleared, no further calls', async () => {
    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('m1') },
        { kind: 'message', message: textMsg('m2') },
        { kind: 'stall', ms: 600_000 }, // long stall — must never matter after break
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);

    // Consume exactly 2 data messages then break (consumer-initiated early return)
    const received: ProviderMessage[] = [];
    for await (const msg of gen) {
      if (msg.type === 'supervisor_status') continue;
      received.push(msg);
      if (received.length === 2) break;
    }

    expect(received.map((m) => m.message?.content?.[0]?.text)).toEqual(['m1', 'm2']);

    // Let the fire-and-forget cleanup microtasks settle
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // (a) The inner provider generator was closed via .return()
    expect(provider.getClosedEarlyCount()).toBe(1);

    // (b) No further executeQuery calls after the break
    expect(provider.getCallCount()).toBe(1);

    const statusCountBefore = statusCallbackEvents.length;

    // (c) Advance fake timers past stallTimeoutMs — the stall timer must have
    // been cleared, so no status events fire and nothing throws
    await vi.advanceTimersByTimeAsync(TEST_POLICY.stallTimeoutMs + 5_000);
    await Promise.resolve();

    expect(provider.getCallCount()).toBe(1);
    expect(statusCallbackEvents.length).toBe(statusCountBefore);
  });
});
