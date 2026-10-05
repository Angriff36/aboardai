import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderMessage } from '@aboardai/types';
import { ProviderFactory } from '../../../src/providers/provider-factory.js';
import { superviseQueryWithFallback } from '../../../src/providers/provider-supervisor.js';
import { simpleQuery } from '../../../src/providers/simple-query-service.js';
import {
  isAccountUnavailable,
  resetModelFallbackState,
  setCodexFallbackModelSource,
} from '../../../src/providers/model-fallback.js';

vi.mock('../../../src/providers/provider-factory.js', () => ({
  ProviderFactory: { getProviderForModel: vi.fn() },
}));

const USAGE_LIMIT = "ActionRequiredError: You've hit your usage limit";

function fakeProvider(name: string, run: () => AsyncGenerator<ProviderMessage>) {
  return { getName: () => name, executeQuery: vi.fn(run) };
}

const text = (value: string): ProviderMessage => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: value }] },
});

describe('model fallback', () => {
  const cursor = fakeProvider('cursor', async function* () {
    yield { type: 'error', error: USAGE_LIMIT };
  });
  const claude = fakeProvider('claude', async function* () {
    yield text('done by backup');
    yield { type: 'result', subtype: 'success', result: 'done by backup' };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelFallbackState();
    setCodexFallbackModelSource(async () => ['codex-gpt-6.1-sol']);
    vi.mocked(ProviderFactory.getProviderForModel).mockImplementation(
      (model: string) => (model.startsWith('cursor') ? cursor : claude) as never
    );
  });

  it('moves a long job to another account when the model is out of usage', async () => {
    const messages: ProviderMessage[] = [];
    for await (const msg of superviseQueryWithFallback(cursor as never, {
      prompt: 'Build it',
      model: 'gpt-5.6-sol',
      cwd: 'C:\\project',
    })) {
      messages.push(msg);
    }

    const switched = messages.find(
      (msg) => (msg as unknown as { status?: string }).status === 'model_switched'
    );
    expect(switched).toBeDefined();
    expect(messages).toContainEqual(text('done by backup'));
    expect(claude.executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5-5', sdkSessionId: undefined })
    );
    expect(isAccountUnavailable('cursor')).toBe(true);
  });

  it('moves a short request to another account when the model is out of usage', async () => {
    const result = await simpleQuery({ prompt: 'Plan', model: 'cursor-gpt-5.6-sol', cwd: 'C:\\p' });

    expect(result.text).toBe('done by backup');
  });

  it('does not switch when the caller asks for this exact model (access probes)', async () => {
    await expect(
      simpleQuery({ prompt: 'ok', model: 'cursor-gpt-5.6-sol', cwd: 'C:\\p', noFallback: true })
    ).rejects.toThrow(/usage limit/);
    expect(claude.executeQuery).not.toHaveBeenCalled();
  });

  it('does not switch on ordinary failures', async () => {
    const broken = fakeProvider('cursor', async function* () {
      yield { type: 'error', error: 'TypeError: cannot read file' };
    });
    vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue(broken as never);

    await expect(
      simpleQuery({ prompt: 'Plan', model: 'cursor-gpt-5.6-sol', cwd: 'C:\\p' })
    ).rejects.toThrow(/cannot read file/);
  });
});
