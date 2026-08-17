import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Terminal, RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { CursorModelId, ModelDefinition } from '@aboardai/types';
import { CURSOR_MODEL_MAP } from '@aboardai/types';
import { getAvailableCursorModels } from '@/components/views/board-view/shared/model-constants';

interface CursorModelConfigurationProps {
  enabledCursorModels: CursorModelId[];
  cursorDefaultModel: CursorModelId;
  isSaving: boolean;
  dynamicModels: ModelDefinition[];
  isLoadingDynamicModels?: boolean;
  onRefreshModels?: () => void;
  onDefaultModelChange: (model: CursorModelId) => void;
  onModelToggle: (model: CursorModelId, enabled: boolean) => void;
}

export function CursorModelConfiguration({
  enabledCursorModels,
  cursorDefaultModel,
  isSaving,
  dynamicModels,
  isLoadingDynamicModels = false,
  onRefreshModels,
  onDefaultModelChange,
  onModelToggle,
}: CursorModelConfigurationProps) {
  const availableModels = useMemo(
    () => getAvailableCursorModels(enabledCursorModels, dynamicModels),
    [enabledCursorModels, dynamicModels]
  );

  const allDiscoveredModels = useMemo(
    () => getAvailableCursorModels([], dynamicModels),
    [dynamicModels]
  );

  const enabledForDefault = availableModels.filter((model) =>
    enabledCursorModels.includes(model.id as CursorModelId)
  );

  const modelLabel = (modelId: string, fallbackLabel: string) => {
    const staticConfig = CURSOR_MODEL_MAP[modelId as CursorModelId];
    return staticConfig?.label ?? fallbackLabel;
  };

  const modelDescription = (modelId: string, fallbackDescription: string) => {
    const staticConfig = CURSOR_MODEL_MAP[modelId as CursorModelId];
    return staticConfig?.description ?? fallbackDescription;
  };

  const modelHasThinking = (modelId: string) => {
    const staticConfig = CURSOR_MODEL_MAP[modelId as CursorModelId];
    return (
      staticConfig?.hasThinking ?? (modelId.includes('-thinking') || modelId.endsWith('-high'))
    );
  };

  return (
    <div
      className={cn(
        'rounded-2xl overflow-hidden',
        'border border-border/50',
        'bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl',
        'shadow-sm shadow-black/5'
      )}
    >
      <div className="p-6 border-b border-border/50 bg-gradient-to-r from-transparent via-accent/5 to-transparent">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500/20 to-brand-600/10 flex items-center justify-center border border-brand-500/20">
              <Terminal className="w-5 h-5 text-brand-500" />
            </div>
            <h2 className="text-lg font-semibold text-foreground tracking-tight">
              Model Configuration
            </h2>
          </div>
          {onRefreshModels && (
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
          )}
        </div>
        <p className="text-sm text-muted-foreground/80 ml-12">
          Models discovered from Cursor CLI ({allDiscoveredModels.length} available)
        </p>
      </div>
      <div className="p-6 space-y-6">
        {/* Default Model */}
        <div className="space-y-2">
          <Label>Default Model</Label>
          <Select
            value={cursorDefaultModel}
            onValueChange={(v) => onDefaultModelChange(v as CursorModelId)}
            disabled={isSaving || enabledForDefault.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {enabledForDefault.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <div className="flex items-center gap-2">
                    <span>{model.label}</span>
                    {model.hasThinking && (
                      <Badge variant="outline" className="text-xs">
                        Thinking
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Enabled Models */}
        <div className="space-y-3">
          <Label>Available Models</Label>
          {isLoadingDynamicModels && allDiscoveredModels.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Spinner className="w-4 h-4" />
              Loading models from Cursor CLI...
            </div>
          ) : allDiscoveredModels.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No models found. Install Cursor CLI and click Refresh models.
            </p>
          ) : (
            <div className="grid gap-3">
              {allDiscoveredModels.map((model) => {
                const isEnabled = enabledCursorModels.includes(model.id as CursorModelId);
                const isAuto = model.id === 'cursor-auto';

                return (
                  <div
                    key={model.id}
                    className="flex items-center justify-between p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={isEnabled}
                        onCheckedChange={(checked) =>
                          onModelToggle(model.id as CursorModelId, !!checked)
                        }
                        disabled={isSaving || isAuto}
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {modelLabel(model.id, model.label)}
                          </span>
                          {modelHasThinking(model.id) && (
                            <Badge variant="outline" className="text-xs">
                              Thinking
                            </Badge>
                          )}
                          {!CURSOR_MODEL_MAP[model.id as CursorModelId] && (
                            <Badge variant="secondary" className="text-xs">
                              CLI
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {modelDescription(model.id, model.description)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
