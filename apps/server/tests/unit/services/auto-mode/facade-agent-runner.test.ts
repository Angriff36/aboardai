import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies (hoisted)
vi.mock('../../../../src/services/agent-executor.js');
vi.mock('../../../../src/lib/settings-helpers.js');
vi.mock('../../../../src/providers/provider-factory.js');
vi.mock('../../../../src/lib/sdk-options.js');
vi.mock('@aboardai/model-resolver', () => ({
  resolveModelString: vi.fn((model, fallback) => model || fallback),
  DEFAULT_MODELS: { claude: 'claude-3-5-sonnet' },
}));

import { AutoModeServiceFacade } from '../../../../src/services/auto-mode/facade.js';
import { AgentExecutor } from '../../../../src/services/agent-executor.js';
import * as settingsHelpers from '../../../../src/lib/settings-helpers.js';
import { ProviderFactory } from '../../../../src/providers/provider-factory.js';
import * as sdkOptions from '../../../../src/lib/sdk-options.js';

describe('AutoModeServiceFacade Agent Runner', () => {
  let mockAgentExecutor: MockAgentExecutor;
  let mockSettingsService: MockSettingsService;
  let facade: AutoModeServiceFacade;

  // Type definitions for mocks
  interface MockAgentExecutor {
    execute: ReturnType<typeof vi.fn>;
  }
  interface MockSettingsService {
    getGlobalSettings: ReturnType<typeof vi.fn>;
    getCredentials: ReturnType<typeof vi.fn>;
    getProjectSettings: ReturnType<typeof vi.fn>;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the mock for createAutoModeOptions
    // Note: Using 'as any' because Options type from SDK is complex and we only need
    // the specific fields that are verified in tests (maxTurns, allowedTools, etc.)
    vi.mocked(sdkOptions.createAutoModeOptions).mockReturnValue({
      maxTurns: 123,
      allowedTools: ['tool1'],
      systemPrompt: 'system-prompt',
    } as any);

    mockAgentExecutor = {
      execute: vi.fn().mockResolvedValue(undefined),
    };
    (AgentExecutor as any).mockImplementation(function (this: MockAgentExecutor) {
      return mockAgentExecutor;
    });

    mockSettingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({}),
      getCredentials: vi.fn().mockResolvedValue({}),
      getProjectSettings: vi.fn().mockResolvedValue({}),
    };

    // Helper to access the private createRunAgentFn via factory creation
    facade = AutoModeServiceFacade.create('/project', {
      events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()) } as any,
      settingsService: mockSettingsService,
      sharedServices: {
        eventBus: { emitAutoModeEvent: vi.fn() } as any,
        worktreeResolver: { getCurrentBranch: vi.fn().mockResolvedValue('main') } as any,
        concurrencyManager: {
          isRunning: vi.fn().mockReturnValue(false),
          getRunningFeature: vi.fn().mockReturnValue(null),
        } as any,
      } as any,
    });
  });

  it('should resolve provider by providerId and pass to AgentExecutor', async () => {
    // 1. Setup mocks
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = { id: 'zai-1', name: 'Zai' };
    const mockCredentials = { apiKey: 'test-key' };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: mockCredentials,
      resolvedModel: undefined,
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    // 2. Execute
    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {
        providerId: 'zai-1',
      }
    );

    // 3. Verify
    expect(settingsHelpers.resolveProviderContext).toHaveBeenCalledWith(
      mockSettingsService,
      'model-1',
      'zai-1',
      '[AutoModeFacade]'
    );

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeCompatibleProvider: mockClaudeProvider,
        credentials: mockCredentials,
        model: 'model-1', // Original model ID
      }),
      expect.any(Object)
    );
  });

  it('should fallback to model-based lookup if providerId is not provided', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = { id: 'zai-model', name: 'Zai Model' };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: { apiKey: 'model-key' },
      resolvedModel: 'resolved-model-1',
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {
        // no providerId
      }
    );

    expect(settingsHelpers.resolveProviderContext).toHaveBeenCalledWith(
      mockSettingsService,
      'model-1',
      undefined,
      '[AutoModeFacade]'
    );

    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeCompatibleProvider: mockClaudeProvider,
      }),
      expect.any(Object)
    );
  });

  it('should pass custom subagents to AgentExecutor when enabled', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: undefined,
      credentials: undefined,
      resolvedModel: undefined,
    });
    (settingsHelpers.getSubagentsConfiguration as any).mockResolvedValue({
      enabled: true,
      sources: ['user', 'project'],
      shouldIncludeInTools: true,
    });
    const customSubagents = {
      'code-explorer': {
        description: 'Explores the codebase',
        prompt: 'You explore code.',
        model: 'haiku',
      },
    };
    (settingsHelpers.getCustomSubagents as any).mockResolvedValue(customSubagents);

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {}
    );

    // Subagents load from project settings at the project path, not the worktree
    expect(settingsHelpers.getCustomSubagents).toHaveBeenCalledWith(
      mockSettingsService,
      '/project'
    );
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: customSubagents,
      }),
      expect.any(Object)
    );
  });

  it('should not load subagents when disabled in settings', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: undefined,
      credentials: undefined,
      resolvedModel: undefined,
    });
    (settingsHelpers.getSubagentsConfiguration as any).mockResolvedValue({
      enabled: false,
      sources: [],
      shouldIncludeInTools: false,
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'model-1',
      {}
    );

    expect(settingsHelpers.getCustomSubagents).not.toHaveBeenCalled();
    const executeArg = mockAgentExecutor.execute.mock.calls[0][0];
    expect(executeArg.agents).toBeUndefined();
  });

  it('should use resolvedModel from provider config for createAutoModeOptions if it maps to a Claude model', async () => {
    const mockProvider = { getName: () => 'mock-provider' };
    (ProviderFactory.getProviderForModel as any).mockReturnValue(mockProvider);

    const mockClaudeProvider = {
      id: 'zai-1',
      name: 'Zai',
      models: [{ id: 'custom-model-1', mapsToClaudeModel: 'claude-3-opus' }],
    };
    (settingsHelpers.resolveProviderContext as any).mockResolvedValue({
      provider: mockClaudeProvider,
      credentials: { apiKey: 'test-key' },
      resolvedModel: 'claude-3-5-opus',
    });

    const runAgentFn = (facade as any).executionService.runAgentFn;

    await runAgentFn(
      '/workdir',
      'feature-1',
      'prompt',
      new AbortController(),
      '/project',
      [],
      'custom-model-1',
      {
        providerId: 'zai-1',
      }
    );

    // Verify createAutoModeOptions was called with the mapped model
    expect(sdkOptions.createAutoModeOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-3-5-opus',
      })
    );

    // Verify AgentExecutor.execute still gets the original custom model ID
    expect(mockAgentExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-model-1',
      }),
      expect.any(Object)
    );
  });
});
