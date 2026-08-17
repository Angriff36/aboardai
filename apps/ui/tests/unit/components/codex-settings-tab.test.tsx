import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSettingsTab } from '@/components/views/settings-view/providers/codex-settings-tab';

const mocks = vi.hoisted(() => ({
  fetchCodexModels: vi.fn(),
  modelConfiguration: vi.fn(),
}));

const discoveredModels = [
  {
    id: 'codex-gpt-5.5',
    label: 'GPT-5.5',
    description: 'Local CLI default',
    hasThinking: true,
    supportsVision: true,
    tier: 'standard' as const,
    isDefault: true,
  },
];

vi.mock('@/store/app-store', () => ({
  useAppStore: () => ({
    codexAutoLoadAgents: false,
    codexEnableWebSearch: false,
    codexEnableImages: false,
    enabledCodexModels: ['codex-gpt-5.5'],
    codexDefaultModel: 'codex-gpt-5.5',
    codexModels: discoveredModels,
    fetchCodexModels: mocks.fetchCodexModels,
    setCodexAutoLoadAgents: vi.fn(),
    setCodexEnableWebSearch: vi.fn(),
    setCodexEnableImages: vi.fn(),
    setCodexDefaultModel: vi.fn(),
    toggleCodexModel: vi.fn(),
  }),
}));

vi.mock('@/store/setup-store', () => ({
  useSetupStore: () => ({
    codexAuthStatus: null,
    codexCliStatus: null,
    setCodexCliStatus: vi.fn(),
    setCodexAuthStatus: vi.fn(),
  }),
}));

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => undefined,
}));

vi.mock('@/components/views/settings-view/providers/codex-model-configuration', () => ({
  CodexModelConfiguration: (props: unknown) => {
    mocks.modelConfiguration(props);
    return null;
  },
}));

vi.mock('@/components/views/settings-view/cli-status/codex-cli-status', () => ({
  CodexCliStatus: () => null,
}));

vi.mock('@/components/views/settings-view/codex/codex-settings', () => ({
  CodexSettings: () => null,
}));

vi.mock('@/components/views/settings-view/codex/codex-usage-section', () => ({
  CodexUsageSection: () => null,
}));

vi.mock('@/components/views/settings-view/providers/provider-toggle', () => ({
  ProviderToggle: () => null,
}));

describe('CodexSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads local Codex CLI models and passes them to model configuration', async () => {
    render(<CodexSettingsTab />);

    await waitFor(() => expect(mocks.fetchCodexModels).toHaveBeenCalled());
    expect(mocks.modelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ availableModels: discoveredModels })
    );
  });
});
