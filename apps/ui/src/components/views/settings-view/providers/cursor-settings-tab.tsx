import { useState, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import type { CursorModelId } from '@aboardai/types';
import {
  CursorCliStatus,
  CursorCliStatusSkeleton,
  CursorPermissionsSkeleton,
  ModelConfigSkeleton,
} from '../cli-status/cursor-cli-status';
import { useCursorStatus } from '../hooks/use-cursor-status';
import { useCursorPermissions } from '../hooks/use-cursor-permissions';
import { CursorPermissionsSection } from './cursor-permissions-section';
import { CursorModelConfiguration } from './cursor-model-configuration';
import { ProviderToggle } from './provider-toggle';
import { useCursorModels } from '@/hooks/queries';
import { queryKeys } from '@/lib/query-keys';

export function CursorSettingsTab() {
  const queryClient = useQueryClient();
  const {
    enabledCursorModels,
    cursorDefaultModel,
    setCursorDefaultModel,
    toggleCursorModel,
    currentProject,
    syncCursorModelsDiscovery,
  } = useAppStore();

  const { status, isLoading, loadData } = useCursorStatus();
  const {
    permissions,
    isLoadingPermissions,
    isSavingPermissions,
    copiedConfig,
    loadPermissions,
    applyProfile,
    copyConfig,
  } = useCursorPermissions(currentProject?.path);

  const { data: modelsData = [], isFetching: isFetchingModels, refetch } = useCursorModels();

  useEffect(() => {
    if (modelsData.length > 0) {
      void syncCursorModelsDiscovery(modelsData);
    }
  }, [modelsData, syncCursorModelsDiscovery]);

  const [isSaving, setIsSaving] = useState(false);

  const handleRefreshCursorCli = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.cli.cursor() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.models.cursor() }),
    ]);
    await loadData();
    await refetch();
    toast.success('Cursor CLI refreshed');
  }, [queryClient, loadData, refetch]);

  const handleRefreshModels = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.models.cursor() });
    await refetch();
    toast.success('Cursor models refreshed');
  }, [queryClient, refetch]);

  const handleDefaultModelChange = (model: CursorModelId) => {
    setIsSaving(true);
    try {
      setCursorDefaultModel(model);
      toast.success('Default model updated');
    } catch {
      toast.error('Failed to update default model');
    } finally {
      setIsSaving(false);
    }
  };

  const handleModelToggle = (model: CursorModelId, enabled: boolean) => {
    setIsSaving(true);
    try {
      toggleCursorModel(model, enabled);
    } catch {
      toast.error('Failed to update models');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <CursorCliStatusSkeleton />
        <CursorPermissionsSkeleton />
        <ModelConfigSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ProviderToggle provider="cursor" providerLabel="Cursor" />

      <CursorCliStatus status={status} isChecking={isLoading} onRefresh={handleRefreshCursorCli} />

      <CursorPermissionsSection
        status={status}
        permissions={permissions}
        isLoadingPermissions={isLoadingPermissions}
        isSavingPermissions={isSavingPermissions}
        copiedConfig={copiedConfig}
        currentProject={currentProject}
        onApplyProfile={applyProfile}
        onCopyConfig={copyConfig}
        onLoadPermissions={loadPermissions}
      />

      {status?.installed && (
        <CursorModelConfiguration
          enabledCursorModels={enabledCursorModels}
          cursorDefaultModel={cursorDefaultModel}
          isSaving={isSaving}
          dynamicModels={modelsData}
          isLoadingDynamicModels={isFetchingModels}
          onRefreshModels={handleRefreshModels}
          onDefaultModelChange={handleDefaultModelChange}
          onModelToggle={handleModelToggle}
        />
      )}
    </div>
  );
}

export default CursorSettingsTab;
