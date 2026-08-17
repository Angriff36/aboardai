import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  ModelAssignmentCandidate,
  ModelId,
  ReasoningEffort,
  ThinkingLevel,
} from '@aboardai/types';
import { getThinkingLevelsForModel, supportsReasoningEffort } from '@aboardai/types';
import { useCursorModels, useOpencodeModels } from '@/hooks/queries';
import { useAppStore } from '@/store/app-store';
import {
  CLAUDE_MODELS,
  COPILOT_MODELS,
  GEMINI_MODELS,
  OPENCODE_MODELS,
  getAvailableCursorModels,
} from '@/components/views/board-view/shared/model-constants';

function optionalThinkingLevel(
  model: string,
  configured: ThinkingLevel
): ThinkingLevel | undefined {
  return getThinkingLevelsForModel(model).includes(configured) ? configured : undefined;
}

function optionalReasoningEffort(
  model: string,
  configured: ReasoningEffort
): ReasoningEffort | undefined {
  return supportsReasoningEffort(model) ? configured : undefined;
}

export function useFeatureModelCatalog(): {
  candidates: ModelAssignmentCandidate[];
  isLoading: boolean;
  error: Error | null;
} {
  const {
    enabledCursorModels,
    cursorDefaultModel,
    enabledGeminiModels,
    geminiDefaultModel,
    enabledCopilotModels,
    copilotDefaultModel,
    enabledOpencodeModels,
    opencodeDefaultModel,
    enabledDynamicModelIds,
    disabledProviders,
    codexModels,
    codexModelsLoading,
    codexDefaultModel,
    fetchCodexModels,
    claudeCompatibleProviders,
    defaultFeatureModel,
    defaultThinkingLevel,
    defaultReasoningEffort,
  } = useAppStore(
    useShallow((state) => ({
      enabledCursorModels: state.enabledCursorModels,
      cursorDefaultModel: state.cursorDefaultModel,
      enabledGeminiModels: state.enabledGeminiModels,
      geminiDefaultModel: state.geminiDefaultModel,
      enabledCopilotModels: state.enabledCopilotModels,
      copilotDefaultModel: state.copilotDefaultModel,
      enabledOpencodeModels: state.enabledOpencodeModels,
      opencodeDefaultModel: state.opencodeDefaultModel,
      enabledDynamicModelIds: state.enabledDynamicModelIds,
      disabledProviders: state.disabledProviders,
      codexModels: state.codexModels,
      codexModelsLoading: state.codexModelsLoading,
      codexDefaultModel: state.codexDefaultModel,
      fetchCodexModels: state.fetchCodexModels,
      claudeCompatibleProviders: state.claudeCompatibleProviders,
      defaultFeatureModel: state.defaultFeatureModel,
      defaultThinkingLevel: state.defaultThinkingLevel,
      defaultReasoningEffort: state.defaultReasoningEffort,
    }))
  );
  const cursorQuery = useCursorModels();
  const opencodeQuery = useOpencodeModels();

  useEffect(() => {
    if (codexModels.length === 0 && !codexModelsLoading) {
      void fetchCodexModels().catch(() => undefined);
    }
  }, [codexModels.length, codexModelsLoading, fetchCodexModels]);

  const candidates = useMemo(() => {
    const result: ModelAssignmentCandidate[] = [];
    const isDisabled = (provider: (typeof disabledProviders)[number]) =>
      disabledProviders.includes(provider);
    const add = (
      providerKey: string,
      providerLabel: string,
      model: string,
      displayName: string,
      isProviderDefault: boolean,
      providerId?: string,
      thinkingLevel?: ThinkingLevel,
      reasoningEffort?: ReasoningEffort
    ) => {
      result.push({
        key: providerId ? `provider:${providerId}:${model}` : `${providerKey}:${model}`,
        model: model as ModelId,
        displayName,
        providerKey,
        providerLabel,
        providerId,
        thinkingLevel,
        reasoningEffort,
        isProviderDefault,
      });
    };

    if (!isDisabled('claude')) {
      for (const option of CLAUDE_MODELS) {
        const selectedThinking =
          defaultFeatureModel.model === option.id
            ? defaultFeatureModel.thinkingLevel
            : defaultThinkingLevel;
        add(
          'claude',
          'Claude Code',
          option.id,
          option.label,
          defaultFeatureModel.model === option.id,
          undefined,
          optionalThinkingLevel(option.id, selectedThinking ?? 'none')
        );
      }
    }

    if (!isDisabled('cursor')) {
      for (const option of getAvailableCursorModels(enabledCursorModels, cursorQuery.data ?? [])) {
        add('cursor', 'Cursor', option.id, option.label, option.id === cursorDefaultModel);
      }
    }

    if (!isDisabled('codex')) {
      for (const option of codexModels) {
        const selectedEffort =
          defaultFeatureModel.model === option.id
            ? defaultFeatureModel.reasoningEffort
            : defaultReasoningEffort;
        add(
          'codex',
          'Codex',
          option.id,
          option.label,
          option.id === codexDefaultModel ||
            option.isDefault ||
            defaultFeatureModel.model === option.id,
          undefined,
          undefined,
          optionalReasoningEffort(option.id, selectedEffort ?? 'none')
        );
      }
    }

    if (!isDisabled('gemini')) {
      for (const option of GEMINI_MODELS.filter((item) =>
        enabledGeminiModels.includes(item.id as (typeof enabledGeminiModels)[number])
      )) {
        add('gemini', 'Gemini', option.id, option.label, option.id === geminiDefaultModel);
      }
    }

    if (!isDisabled('copilot')) {
      for (const option of COPILOT_MODELS.filter((item) =>
        enabledCopilotModels.includes(item.id as (typeof enabledCopilotModels)[number])
      )) {
        add(
          'copilot',
          'GitHub Copilot',
          option.id,
          option.label,
          option.id === copilotDefaultModel
        );
      }
    }

    if (!isDisabled('opencode')) {
      const staticOptions = OPENCODE_MODELS.filter((item) =>
        (enabledOpencodeModels as string[]).includes(item.id)
      );
      const staticNames = new Set(
        staticOptions.map((item) => item.id.replace(/^opencode[-/]/, ''))
      );
      const dynamicOptions = (opencodeQuery.data ?? [])
        .filter(
          (item) =>
            (enabledDynamicModelIds.length === 0 || enabledDynamicModelIds.includes(item.id)) &&
            !staticNames.has(item.id.replace(/^opencode[-/]/, ''))
        )
        .map((item) => ({ id: item.id, label: item.name, provider: item.provider }));

      for (const option of [...staticOptions, ...dynamicOptions]) {
        const executionGroup =
          'provider' in option && option.provider ? `opencode:${option.provider}` : 'opencode';
        add(
          executionGroup,
          executionGroup === 'opencode' ? 'OpenCode' : `OpenCode · ${option.provider}`,
          option.id,
          option.label,
          option.id === opencodeDefaultModel
        );
      }
    }

    for (const provider of claudeCompatibleProviders ?? []) {
      if (provider.enabled === false) continue;
      provider.models.forEach((model, index) => {
        const selectedThinking =
          defaultFeatureModel.providerId === provider.id && defaultFeatureModel.model === model.id
            ? defaultFeatureModel.thinkingLevel
            : defaultThinkingLevel;
        add(
          `claude-compatible:${provider.id}`,
          provider.name,
          model.id,
          model.displayName,
          index === 0,
          provider.id,
          model.capabilities?.supportsThinking
            ? optionalThinkingLevel(model.id, selectedThinking ?? 'none')
            : undefined
        );
      });
    }

    return result;
  }, [
    claudeCompatibleProviders,
    codexDefaultModel,
    codexModels,
    copilotDefaultModel,
    cursorDefaultModel,
    cursorQuery.data,
    defaultFeatureModel,
    defaultReasoningEffort,
    defaultThinkingLevel,
    disabledProviders,
    enabledCopilotModels,
    enabledCursorModels,
    enabledDynamicModelIds,
    enabledGeminiModels,
    enabledOpencodeModels,
    geminiDefaultModel,
    opencodeDefaultModel,
    opencodeQuery.data,
  ]);

  const queryError = cursorQuery.error ?? opencodeQuery.error;
  return {
    candidates,
    isLoading: codexModelsLoading || cursorQuery.isLoading || opencodeQuery.isLoading,
    error: queryError instanceof Error ? queryError : null,
  };
}
