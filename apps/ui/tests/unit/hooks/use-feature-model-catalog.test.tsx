import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { useFeatureModelCatalog } from '@/components/views/settings-view/model-defaults/use-feature-model-catalog';

vi.mock('@/store/app-store');
let discoveredCursorModels: Array<{
  id: string;
  name: string;
  provider: string;
}> = [];
vi.mock('@/hooks/queries', () => ({
  useCursorModels: () => ({ data: discoveredCursorModels }),
  useOpencodeModels: () => ({ data: [] }),
}));

const mockUseAppStore = vi.mocked(useAppStore);

describe('useFeatureModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoveredCursorModels = [];
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
      syncCursorModelsDiscovery: vi.fn().mockResolvedValue(undefined),
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

  it('synchronizes newly discovered Cursor models from any catalog consumer', () => {
    discoveredCursorModels = [
      { id: 'cursor-composer-2.5', name: 'Composer 2.5', provider: 'cursor' },
      {
        id: 'cursor-grok-4.6-high-fast',
        name: 'Cursor Grok 4.6 Fast',
        provider: 'cursor',
      },
    ];
    const syncCursorModelsDiscovery = vi.fn().mockResolvedValue(undefined);
    const state = {
      enabledCursorModels: discoveredCursorModels.map((model) => model.id),
      cursorDefaultModel: 'cursor-composer-2.5',
      enabledGeminiModels: [],
      enabledCopilotModels: [],
      enabledOpencodeModels: [],
      enabledDynamicModelIds: [],
      disabledProviders: ['claude', 'codex', 'gemini', 'copilot', 'opencode'],
      codexModels: [],
      codexModelsLoading: false,
      fetchCodexModels: vi.fn().mockResolvedValue(undefined),
      syncCursorModelsDiscovery,
      claudeCompatibleProviders: [],
      defaultFeatureModel: { model: 'cursor-composer-2.5' },
      defaultThinkingLevel: 'medium',
      defaultReasoningEffort: 'medium',
    };
    mockUseAppStore.mockImplementation((selector?: unknown) =>
      typeof selector === 'function' ? selector(state) : state
    );

    const { result } = renderHook(() => useFeatureModelCatalog());

    expect(syncCursorModelsDiscovery).toHaveBeenCalledWith(discoveredCursorModels);
    expect(result.current.candidates.map((candidate) => candidate.model)).toEqual([
      'cursor-composer-2.5',
      'cursor-grok-4.6-high-fast',
    ]);
  });
});
