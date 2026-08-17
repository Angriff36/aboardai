import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { useFeatureModelCatalog } from '@/components/views/settings-view/model-defaults/use-feature-model-catalog';

vi.mock('@/store/app-store');
vi.mock('@/hooks/queries', () => ({
  useCursorModels: () => ({ data: [] }),
  useOpencodeModels: () => ({ data: [] }),
}));

const mockUseAppStore = vi.mocked(useAppStore);

describe('useFeatureModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enabled models in provider order with exact subscription identities', () => {
    const state = {
      enabledCursorModels: ['cursor-auto'],
      enabledGeminiModels: [],
      enabledCopilotModels: [],
      enabledOpencodeModels: [],
      enabledDynamicModelIds: [],
      disabledProviders: ['claude', 'gemini', 'copilot', 'opencode'],
      codexModels: [
        {
          id: 'codex-gpt-5.2-codex',
          label: 'GPT-5.2 Codex',
          description: 'Coding model',
          tier: 'premium',
        },
      ],
      codexModelsLoading: false,
      fetchCodexModels: vi.fn().mockResolvedValue(undefined),
      claudeCompatibleProviders: [
        {
          id: 'zai',
          name: 'Z.AI',
          providerType: 'glm',
          enabled: true,
          models: [{ id: 'glm-5', displayName: 'GLM 5' }],
          defaultModel: 'glm-5',
        },
      ],
      defaultFeatureModel: { model: 'codex-gpt-5.2-codex', reasoningEffort: 'high' },
      defaultThinkingLevel: 'medium',
      defaultReasoningEffort: 'medium',
    };

    mockUseAppStore.mockImplementation((selector?: unknown) =>
      typeof selector === 'function' ? selector(state) : state
    );

    const { result } = renderHook(() => useFeatureModelCatalog());

    expect(
      result.current.candidates.map((candidate) => ({
        key: candidate.key,
        providerKey: candidate.providerKey,
        isProviderDefault: candidate.isProviderDefault,
        reasoningEffort: candidate.reasoningEffort,
      }))
    ).toEqual([
      {
        key: 'cursor:cursor-auto',
        providerKey: 'cursor',
        isProviderDefault: false,
        reasoningEffort: undefined,
      },
      {
        key: 'codex:codex-gpt-5.2-codex',
        providerKey: 'codex',
        isProviderDefault: true,
        reasoningEffort: 'high',
      },
      {
        key: 'provider:zai:glm-5',
        providerKey: 'claude-compatible:zai',
        isProviderDefault: true,
        reasoningEffort: undefined,
      },
    ]);
  });
});
