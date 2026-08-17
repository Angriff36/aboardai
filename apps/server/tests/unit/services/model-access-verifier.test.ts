import { describe, expect, it, vi } from 'vitest';
import type { ModelAssignmentCandidate } from '@aboardai/types';
import { verifyModelAccess } from '@/services/model-access-verifier.js';
import type { SettingsService } from '@/services/settings-service.js';

const native: ModelAssignmentCandidate = {
  key: 'codex:codex-gpt-5.2-codex',
  model: 'codex-gpt-5.2-codex',
  displayName: 'GPT-5.2 Codex',
  providerKey: 'codex',
  providerLabel: 'Codex',
  reasoningEffort: 'high',
  isProviderDefault: true,
};

const compatible: ModelAssignmentCandidate = {
  key: 'provider:zai:glm-5',
  model: 'glm-5',
  displayName: 'GLM 5',
  providerKey: 'claude-compatible:zai',
  providerLabel: 'Z.AI',
  providerId: 'zai',
  thinkingLevel: 'medium',
  isProviderDefault: true,
};

const claudeOpus: ModelAssignmentCandidate = {
  key: 'claude:claude-opus',
  model: 'claude-opus',
  displayName: 'Claude Opus',
  providerKey: 'claude',
  providerLabel: 'Claude Code',
  isProviderDefault: true,
};

const claudeFable: ModelAssignmentCandidate = {
  ...claudeOpus,
  key: 'claude:claude-fable',
  model: 'claude-fable',
  displayName: 'Claude Fable 5',
  isProviderDefault: false,
};

describe('verifyModelAccess', () => {
  it('probes exact native and compatible model settings in read-only one-turn mode', async () => {
    const provider = { id: 'zai', name: 'Z.AI' };
    const credentials = { anthropicApiKey: 'secret' };
    const probe = vi.fn().mockResolvedValue({ text: 'ok' });
    const resolveProvider = vi.fn().mockResolvedValue({
      provider,
      credentials,
      resolvedModel: 'claude-sonnet-4-6',
      modelConfig: { id: 'glm-5', displayName: 'GLM 5' },
    });

    const results = await verifyModelAccess(
      [native, compatible],
      'C:\\project',
      {} as SettingsService,
      { probe, resolveProvider }
    );

    expect(results).toEqual([
      { key: native.key, status: 'verified' },
      { key: compatible.key, status: 'verified' },
    ]);
    expect(probe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        prompt: 'Reply with only: ok',
        model: native.model,
        cwd: 'C:\\project',
        maxTurns: 1,
        allowedTools: [],
        readOnly: true,
        reasoningEffort: 'high',
      })
    );
    expect(resolveProvider).toHaveBeenCalledWith(
      expect.anything(),
      'glm-5',
      'zai',
      '[ModelAccessVerifier]'
    );
    expect(probe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        claudeCompatibleProvider: provider,
        credentials,
        thinkingLevel: 'medium',
      })
    );
  });

  it('limits concurrency and isolates sanitized failures', async () => {
    let active = 0;
    let maximum = 0;
    const probe = vi.fn(async ({ model }: { model?: string }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (model === 'cursor-fail') {
        throw new Error('401 invalid token at C:\\private\\credentials.json');
      }
      return { text: 'ok' };
    });
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      ...native,
      key: `cursor:${index}`,
      model: (index === 2 ? 'cursor-fail' : `cursor-model-${index}`) as typeof native.model,
    }));

    const results = await verifyModelAccess(candidates, 'C:\\project', {} as SettingsService, {
      probe,
      concurrency: 2,
    });

    expect(maximum).toBe(2);
    expect(results[2]).toEqual({
      key: 'cursor:2',
      status: 'unavailable',
      error: 'Authentication failed',
    });
    expect(results.filter((result) => result.status === 'verified')).toHaveLength(4);
  });

  it('resolves Claude catalog aliases to executable model IDs before probing', async () => {
    const probe = vi.fn().mockResolvedValue({ text: 'ok' });

    const results = await verifyModelAccess(
      [claudeOpus, claudeFable],
      'C:\\project',
      {} as SettingsService,
      { probe }
    );

    expect(results).toEqual([
      { key: claudeOpus.key, status: 'verified' },
      { key: claudeFable.key, status: 'verified' },
    ]);
    expect(probe).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'claude-opus-4-8' }));
    expect(probe).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'claude-fable-5' }));
  });
});
