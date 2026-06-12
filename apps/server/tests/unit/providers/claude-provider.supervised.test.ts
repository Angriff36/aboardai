/**
 * ClaudeProvider × ProviderSupervisor integration
 *
 * Wraps the REAL ClaudeProvider with superviseQuery() and a MOCKED Claude
 * Agent SDK query() so we exercise the full provider→supervisor path:
 *
 *   superviseQuery(new ClaudeProvider(), opts) → ClaudeProvider.executeQuery()
 *     → query() [mocked SDK] → stream of SDKMessages
 *
 * Scenarios (mirror the supervisor S-series against the real provider):
 *   (a) stall → resume call carries `resume` = captured session id   [S1]
 *   (b) thrown 429 'retry after 2 seconds' → wait + resume            [S3]
 *   (c) crash mid-stream then succeed → message continuity            [S5]
 *   (d) 'session not found' on resume → fresh retry without resume    [S7]
 *
 * Fake timers drive stall/backoff delays. A small policy keeps numbers tidy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeProvider } from '@/providers/claude-provider.js';
import { superviseQuery } from '@/providers/provider-supervisor.js';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { ExecuteOptions, ProviderMessage, SupervisorPolicy } from '@aboardai/types';

vi.mock('@anthropic-ai/claude-agent-sdk');

vi.mock('@aboardai/platform', () => ({
  getClaudeAuthIndicators: vi.fn().mockResolvedValue({
    credentials: null,
    hasSettingsFile: false,
    hasStatsCacheWithActivity: false,
    hasProjectsSessions: false,
  }),
}));

// ---------------------------------------------------------------------------
// Small policy for fast fake-timer tests
// ---------------------------------------------------------------------------

const TEST_POLICY: SupervisorPolicy = {
  stallTimeoutMs: 5_000,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

// ---------------------------------------------------------------------------
// SDK message factories (shapes match what the supervisor inspects)
// ---------------------------------------------------------------------------

function initMsg(sessionId: string): ProviderMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as unknown as ProviderMessage;
}

function textMsg(text: string, sessionId?: string): ProviderMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as ProviderMessage;
}

function resultMsg(sessionId?: string): ProviderMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: 'done',
  } as ProviderMessage;
}

/** setTimeout-based sleep so fake timers drive it; abortable via generator .return(). */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Scripted SDK runs — each run is replayed on the N-th query() call.
// ---------------------------------------------------------------------------

type Run =
  | { kind: 'messages'; messages: ProviderMessage[] }
  | { kind: 'stall-after'; messages: ProviderMessage[]; stallMs: number }
  | { kind: 'throw-after'; messages: ProviderMessage[]; error: Error };

/**
 * Install a mocked sdk.query() that:
 * - records the `resume` option of every call (in order)
 * - replays runs[N] on call N (clamps to last)
 * Returns the array that will be filled with each call's `resume` value.
 */
function installSdkRuns(runs: Run[]): { resumes: (string | undefined)[]; callCount: () => number } {
  const resumes: (string | undefined)[] = [];
  let callIndex = 0;

  vi.mocked(sdk.query).mockImplementation((args: unknown) => {
    const opts = (args as { options?: { resume?: string } }).options ?? {};
    resumes.push(opts.resume);

    const run = runs[Math.min(callIndex, runs.length - 1)];
    callIndex++;

    return (async function* () {
      switch (run.kind) {
        case 'messages':
          for (const m of run.messages) yield m;
          return;
        case 'stall-after':
          for (const m of run.messages) yield m;
          // Stall: emit nothing for stallMs (supervisor watchdog fires).
          await sleep(run.stallMs);
          return;
        case 'throw-after':
          for (const m of run.messages) yield m;
          throw run.error;
      }
    })() as ReturnType<typeof sdk.query>;
  });

  return { resumes, callCount: () => callIndex };
}

function defaultOptions(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    prompt: 'do the thing',
    model: 'claude-opus-4-8',
    cwd: '/tmp/test',
    ...overrides,
  };
}

/** Drive an async generator to completion while advancing fake timers in steps. */
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
      for await (const msg of gen) messages.push(msg);
    } catch (e) {
      error = e;
    } finally {
      done = true;
    }
  };

  const p = iterate();
  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await Promise.resolve();
  }
  await p;
  return { messages, error };
}

function dataTexts(messages: ProviderMessage[]): (string | undefined)[] {
  return messages
    .filter((m) => m.type !== 'supervisor_status' && m.message?.content?.[0])
    .map((m) => m.message?.content?.[0]?.text);
}

function statuses(messages: ProviderMessage[]): string[] {
  return messages
    .filter((m) => m.type === 'supervisor_status')
    .map((m) => (m as unknown as { status: string }).status);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeProvider × ProviderSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) S1 — stall → resume with captured session id
  it('S1: stall mid-stream → resume call carries the captured session_id', async () => {
    const SESSION = 'sess-A';

    const { resumes, callCount } = installSdkRuns([
      {
        kind: 'stall-after',
        messages: [initMsg(SESSION), textMsg('msg-1', SESSION)],
        stallMs: TEST_POLICY.stallTimeoutMs + 2_000,
      },
      {
        kind: 'messages',
        messages: [textMsg('resumed-msg', SESSION), resultMsg(SESSION)],
      },
    ]);

    const provider = new ClaudeProvider();
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY);

    const { messages, error } = await collectWithFakeTimers(gen, 1_000, 20);

    expect(error).toBeUndefined();
    expect(callCount()).toBeGreaterThanOrEqual(2);

    // First query() call had no resume; the SECOND (post-stall) resumed with the
    // session id captured from the init system message of the first run.
    expect(resumes[0]).toBeUndefined();
    expect(resumes[1]).toBe(SESSION);

    // Continuation spliced into the same output stream.
    expect(dataTexts(messages)).toContain('resumed-msg');
    expect(statuses(messages)).toContain('stalled');
    expect(statuses(messages)).toContain('resumed');
  });

  // (b) S3 — thrown 429 with retry-after → wait then resume
  it('S3: thrown 429 with "wait 2 seconds" → honors 2s delay then resumes', async () => {
    const SESSION = 'sess-B';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { resumes, callCount } = installSdkRuns([
      {
        // "please wait 2 seconds" is parseable by classifyError(), so retryAfter=2
        // is set on the enhanced error's structured property. The supervisor
        // (extractRateLimitDelayMs) prefers that structured value — it does NOT
        // need a text suffix. The exact 2000ms wait proves the structured path works.
        kind: 'throw-after',
        messages: [initMsg(SESSION), textMsg('partial', SESSION)],
        error: new Error('429 rate limit exceeded, please wait 2 seconds before retrying'),
      },
      {
        kind: 'messages',
        messages: [textMsg('after-rl', SESSION), resultMsg(SESSION)],
      },
    ]);

    const provider = new ClaudeProvider();
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY);

    // Drive to completion, advancing fake timers in small steps so the 2s
    // rate-limit wait elapses and the retry fires.
    const { messages, error } = await collectWithFakeTimers(gen, 250, 30);

    expect(error).toBeUndefined();
    expect(callCount()).toBeGreaterThanOrEqual(2);

    // Resume carried the captured session id; status shows rate_limited with
    // the precise 2000ms delay read from the provider's structured retryAfter
    // property. The exact 2000ms (vs generic backoff of 100ms) proves the
    // server's retry-after hint survived the provider's error rewrite and was
    // honored via the structured channel (not text parsing).
    expect(resumes[1]).toBe(SESSION);
    const rl = messages
      .filter((m) => m.type === 'supervisor_status')
      .find((m) => (m as unknown as { status: string }).status === 'rate_limited');
    expect(rl).toBeDefined();
    expect((rl as unknown as { retryAfterMs: number }).retryAfterMs).toBe(2_000);

    // Continuation after the rate limit was spliced into the same stream.
    expect(dataTexts(messages)).toContain('after-rl');

    consoleErrorSpy.mockRestore();
  });

  // (c) S5 — crash mid-stream then success → message continuity, no dupes
  it('S5: crash mid-stream then succeed → consumer gets all messages in order', async () => {
    const SESSION = 'sess-C';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { callCount } = installSdkRuns([
      {
        kind: 'throw-after',
        messages: [initMsg(SESSION), textMsg('r0-m1', SESSION), textMsg('r0-m2', SESSION)],
        error: new Error('500 internal server error'),
      },
      {
        kind: 'messages',
        messages: [textMsg('r1-m1', SESSION), resultMsg(SESSION)],
      },
    ]);

    const provider = new ClaudeProvider();
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY);

    const { messages, error } = await collectWithFakeTimers(gen, 200, 20);

    expect(error).toBeUndefined();
    expect(callCount()).toBeGreaterThanOrEqual(2);

    const texts = dataTexts(messages);
    expect(texts.indexOf('r0-m1')).toBeLessThan(texts.indexOf('r0-m2'));
    expect(texts.indexOf('r0-m2')).toBeLessThan(texts.indexOf('r1-m1'));

    // No duplicates among the forwarded text messages.
    const present = texts.filter((t): t is string => typeof t === 'string');
    expect(new Set(present).size).toBe(present.length);

    // Final result forwarded.
    const data = messages.filter((m) => m.type === 'result');
    expect(data.length).toBeGreaterThanOrEqual(1);

    consoleErrorSpy.mockRestore();
  });

  // (d) S7 — 'session not found' on resume → fresh retry WITHOUT resume
  it('S7: session-not-found on resume → next attempt starts fresh (no resume)', async () => {
    const SESSION = 'sess-D';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { resumes, callCount } = installSdkRuns([
      // Run 0: capture session, then crash (retryable network) → triggers resume.
      {
        kind: 'throw-after',
        messages: [initMsg(SESSION)],
        error: new Error('ECONNRESET: connection reset'),
      },
      // Run 1: resume attempt rejected as stale session.
      {
        kind: 'throw-after',
        messages: [],
        error: new Error('session not found'),
      },
      // Run 2: fresh start (no resume) succeeds.
      {
        kind: 'messages',
        messages: [textMsg('fresh-start'), resultMsg()],
      },
    ]);

    const provider = new ClaudeProvider();
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY);

    const { messages, error } = await collectWithFakeTimers(gen, 200, 30);

    expect(error).toBeUndefined();
    expect(callCount()).toBeGreaterThanOrEqual(3);

    // Call sequence of resume values:
    //  [0] undefined (initial), [1] SESSION (resume), [2] undefined (cleared after stale).
    expect(resumes[0]).toBeUndefined();
    expect(resumes[1]).toBe(SESSION);
    expect(resumes[2]).toBeUndefined();

    expect(dataTexts(messages)).toContain('fresh-start');
    expect(messages.some((m) => m.type === 'result')).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});
