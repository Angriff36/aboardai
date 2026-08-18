import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderFactory } from '../../../src/providers/provider-factory.js';
import { simpleQuery } from '../../../src/providers/simple-query-service.js';

vi.mock('../../../src/providers/provider-factory.js', () => ({
  ProviderFactory: {
    getProviderForModel: vi.fn(),
  },
}));

describe('simpleQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables provider tools when the one-shot query allows no tools', async () => {
    const executeQuery = vi.fn(async function* () {
      yield { type: 'result' as const, subtype: 'success' as const, result: 'brief' };
    });
    vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue({
      executeQuery,
    } as never);

    const result = await simpleQuery({
      prompt: 'Plan the feature without editing files',
      model: 'claude-fable-5',
      cwd: 'C:\\project',
      maxTurns: 1,
      allowedTools: [],
      readOnly: true,
    });

    expect(result.text).toBe('brief');
    expect(executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: [],
        tools: [],
      })
    );
  });

  it('rejects a provider turn-limit result when no response text was produced', async () => {
    const executeQuery = vi.fn(async function* () {
      yield {
        type: 'result' as const,
        subtype: 'error_max_turns' as const,
        result: '',
      };
    });
    vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue({
      executeQuery,
    } as never);

    await expect(
      simpleQuery({
        prompt: 'Plan the feature',
        model: 'claude-fable-5',
        cwd: 'C:\\project',
        maxTurns: 1,
        allowedTools: [],
      })
    ).rejects.toThrow(/error_max_turns/i);
  });
});
