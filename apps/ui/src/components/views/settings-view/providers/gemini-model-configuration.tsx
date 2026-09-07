import { useMemo } from 'react';
import type { GeminiModelId, ModelDefinition } from '@aboardai/types';
import { GEMINI_MODEL_MAP } from '@aboardai/types';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { GeminiIcon } from '@/components/ui/provider-icon';
import { getAvailableGeminiModels } from '@/components/views/board-view/shared/model-constants';
import { BaseModelConfiguration, type BaseModelInfo } from './shared/base-model-configuration';

interface GeminiModelConfigurationProps {
  enabledGeminiModels: GeminiModelId[];
  geminiDefaultModel: GeminiModelId;
  isSaving: boolean;
  /** Models discovered from the Gemini API (empty → static catalog) */
  dynamicModels?: ModelDefinition[];
  isLoadingDynamicModels?: boolean;
  onRefreshModels?: () => void;
  onDefaultModelChange: (model: GeminiModelId) => void;
  onModelToggle: (model: GeminiModelId, enabled: boolean) => void;
}

interface GeminiModelInfo extends BaseModelInfo<GeminiModelId> {
  supportsThinking: boolean;
}

export function GeminiModelConfiguration({
  enabledGeminiModels,
  geminiDefaultModel,
  isSaving,
  dynamicModels = [],
  isLoadingDynamicModels = false,
  onRefreshModels,
  onDefaultModelChange,
  onModelToggle,
}: GeminiModelConfigurationProps) {
  // Live list from the Gemini API when available, static GEMINI_MODEL_MAP otherwise
  const models = useMemo<GeminiModelInfo[]>(
    () =>
      getAvailableGeminiModels([], dynamicModels).map((model) => ({
        id: model.id as GeminiModelId,
        label: model.label,
        description: model.description,
        supportsThinking:
          GEMINI_MODEL_MAP[model.id as GeminiModelId]?.supportsThinking ?? !!model.hasThinking,
      })),
    [dynamicModels]
  );

  const isDynamic = dynamicModels.length > 0;

  return (
    <BaseModelConfiguration<GeminiModelId>
      providerName="Gemini"
      icon={<GeminiIcon className="w-5 h-5 text-blue-500" />}
      iconGradient="from-blue-500/20 to-blue-600/10"
      iconBorder="border-blue-500/20"
      models={models}
      enabledModels={enabledGeminiModels}
      defaultModel={geminiDefaultModel}
      isSaving={isSaving}
      onDefaultModelChange={onDefaultModelChange}
      onModelToggle={onModelToggle}
      description={
        isDynamic
          ? `Models discovered from the Gemini API (${models.length} available)`
          : 'Built-in Gemini catalog. Add a Gemini API key to discover models automatically.'
      }
      headerAction={
        onRefreshModels ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefreshModels}
            disabled={isLoadingDynamicModels || isSaving}
          >
            {isLoadingDynamicModels ? (
              <Spinner className="w-4 h-4 mr-2" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Refresh models
          </Button>
        ) : undefined
      }
      getFeatureBadge={(model) => {
        const geminiModel = model as GeminiModelInfo;
        return geminiModel.supportsThinking ? { show: true, label: 'Thinking' } : null;
      }}
    />
  );
}
