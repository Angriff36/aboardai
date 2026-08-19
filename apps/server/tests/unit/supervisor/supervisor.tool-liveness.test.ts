/**
 * ProviderSupervisor — tool-event liveness vs true silence
 *
 * Proves stall detection treats tool_use / tool_result as activity even when
 * there is no assistant text, and still stalls on a truly silent stream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderMessage, SupervisorPolicy, SupervisorStatusMessage } from '@aboardai/types';
import { superviseQuery } from '@/providers/provider-supervisor.js';
import { StreamActivity } from '@/providers/stream-activity.js';
import { FakeProvider } from './fake-provider.js';
import type { FakeRun } from './fake-provider.js';

const TEST_POLICY: SupervisorPolicy = {
  stallTimeoutMs: 5_000,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

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

function resultMsg(sessionId?: string): ProviderMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: 'done',
  };
}

function toolUseMsg(toolName: string, sessionId?: string): ProviderMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: toolName,
          tool_use_id: `tool-${toolName}`,
          input: {},
        },
      ],
    },
  };
}

function toolResultMsg(toolName: string, sessionId?: string): ProviderMessage {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${toolName}`,
          content: 'ok',
        },
      ],
    },
  };
}

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
    await Promise.resolve();
  }

  await iteratePromise;
  return { messages, error };
}

function statusMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.filter((m) => m.type === 'supervisor_status');
}

function dataMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.filter((m) => m.type !== 'supervisor_status');
}

function defaultOptions() {
  return {
    prompt: 'test prompt',
    model: 'fake-model-1',
    cwd: '/tmp/test',
  };
}

describe('ProviderSupervisor tool-event liveness', () => {
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

  it('StreamActivity: tool_use and tool_result count as liveness', () => {
    expect(StreamActivity.isLivenessSignal(toolUseMsg('Bash'))).toBe(true);
    expect(StreamActivity.isLivenessSignal(toolResultMsg('Bash'))).toBe(true);
    expect(StreamActivity.isLivenessSignal(textMsg('hi'))).toBe(true);
    expect(
      StreamActivity.isLivenessSignal({
        type: 'supervisor_status',
        status: 'started',
      } as ProviderMessage)
    ).toBe(false);
  });

  it('S13: tool_use / tool_result with no text for > stallTimeoutMs → NOT stalled', async () => {
    const SESSION_ID = 'sess-tool-liveness';
    const gapMs = TEST_POLICY.stallTimeoutMs - 1_000;

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: initMsg(SESSION_ID) },
        { kind: 'message', message: toolUseMsg('Bash', SESSION_ID), delayMs: gapMs },
        { kind: 'message', message: toolResultMsg('Bash', SESSION_ID), delayMs: gapMs },
        { kind: 'message', message: toolUseMsg('Bash', SESSION_ID), delayMs: gapMs },
        { kind: 'message', message: toolResultMsg('Bash', SESSION_ID), delayMs: gapMs },
        { kind: 'message', message: resultMsg(SESSION_ID) },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);
    const { messages, error } = await collectWithFakeTimers(gen, 500, 80);

    expect(error).toBeUndefined();
    expect(provider.getCallCount()).toBe(1);
    expect(
      messages.some((m) => m.type === 'supervisor_status' && (m as any).status === 'stalled')
    ).toBe(false);
    expect(statusCallbackEvents.some((s) => s.status === 'stalled')).toBe(false);

    const data = dataMessages(messages);
    expect(data.some((m) => m.message?.content?.[0]?.type === 'tool_use')).toBe(true);
    expect(data.some((m) => m.message?.content?.[0]?.type === 'tool_result')).toBe(true);
    expect(data.some((m) => m.type === 'result')).toBe(true);
  });

  it('S14: truly silent stream for > stallTimeoutMs → stalled + resume', async () => {
    const SESSION_ID = 'sess-true-silence';

    const run0: FakeRun = {
      directives: [
        { kind: 'message', message: initMsg(SESSION_ID) },
        { kind: 'stall', ms: TEST_POLICY.stallTimeoutMs + 2_000 },
        { kind: 'end' },
      ],
    };

    const run1: FakeRun = {
      directives: [
        { kind: 'message', message: textMsg('after-silence', SESSION_ID) },
        { kind: 'message', message: resultMsg(SESSION_ID) },
        { kind: 'end' },
      ],
    };

    const provider = new FakeProvider([run0, run1]);
    const gen = superviseQuery(provider, defaultOptions(), TEST_POLICY, onStatus);
    const { messages, error } = await collectWithFakeTimers(gen, 1_000, 20);

    expect(error).toBeUndefined();
    expect(provider.getCallCount()).toBeGreaterThanOrEqual(2);
    expect(provider.getRecordedOptionsForRun(1)?.sdkSessionId).toBe(SESSION_ID);

    const allStatus = [...statusMessages(messages), ...statusCallbackEvents];
    expect(allStatus.some((s) => (s as any).status === 'stalled')).toBe(true);
    expect(allStatus.some((s) => (s as any).status === 'resumed')).toBe(true);

    const texts = dataMessages(messages)
      .filter((m) => m.message?.content?.[0]?.text)
      .map((m) => m.message?.content?.[0]?.text);
    expect(texts).toContain('after-silence');
  });
});
