/**
 * Models Query Hooks
 *
 * React Query hooks for fetching available AI models.
 */

import { useQuery } from '@tanstack/react-query';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { STALE_TIMES } from '@/lib/query-client';
import type { ModelDefinition } from '@aboardai/types';

interface CodexModel {
  id: string;
  label: string;
  description: string;
  hasThinking: boolean;
  supportsVision: boolean;
  tier: 'premium' | 'standard' | 'basic';
  isDefault: boolean;
}

/**
 * Fetch available models
 *
 * @returns Query result with available models
 */
export function useAvailableModels() {
  return useQuery({
    queryKey: queryKeys.models.available(),
    queryFn: async () => {
      const api = getElectronAPI();
      if (!api.model) {
        throw new Error('Model API not available');
      }
      const result = await api.model.getAvailable();
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch available models');
      }
      return result.models ?? [];
    },
    staleTime: STALE_TIMES.MODELS,
  });
}

/**
 * Fetch Codex models
 *
 * @param refresh - Force refresh from server
 * @returns Query result with Codex models
 */
export function useCodexModels(refresh = false) {
  return useQuery({
    queryKey: queryKeys.models.codex(),
    queryFn: async (): Promise<CodexModel[]> => {
      const api = getElectronAPI();
      if (!api.codex) {
        throw new Error('Codex API not available');
      }
      const result = await api.codex.getModels(refresh);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch Codex models');
      }
      return (result.models ?? []) as CodexModel[];
    },
    staleTime: STALE_TIMES.MODELS,
  });
}

/**
 * Fetch OpenCode models
 *
 * @param refresh - Force refresh from server
 * @returns Query result with OpenCode models
 */
export function useOpencodeModels(refresh = false) {
  return useQuery({
    queryKey: queryKeys.models.opencode(),
    queryFn: async (): Promise<ModelDefinition[]> => {
      const api = getElectronAPI();
      if (!api.setup?.getOpencodeModels) {
        throw new Error('OpenCode models API not available');
      }
      const result = await api.setup.getOpencodeModels(refresh);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch OpenCode models');
      }
      return (result.models ?? []) as ModelDefinition[];
    },
    staleTime: STALE_TIMES.MODELS,
  });
}

/**
 * Fetch Cursor models from cursor-agent --list-models
 */
export function useCursorModels(refresh = false) {
  return useQuery({
    queryKey: queryKeys.models.cursor(),
    queryFn: async (): Promise<ModelDefinition[]> => {
      const api = getElectronAPI();
      if (!api.setup?.getCursorModels) {
        throw new Error('Cursor models API not available');
      }
      const result = await api.setup.getCursorModels(refresh);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch Cursor models');
      }
      return (result.models ?? []) as ModelDefinition[];
    },
    staleTime: STALE_TIMES.MODELS,
    refetchOnMount: refresh ? 'always' : true,
  });
}

/**
 * Fetch Claude models discovered from the Anthropic API.
 * Falls back to the static catalog on the server when no API key is configured.
 */
export function useClaudeModels(refresh = false) {
  return useQuery({
    queryKey: queryKeys.models.claude(),
    queryFn: async (): Promise<ModelDefinition[]> => {
      const api = getElectronAPI();
      if (!api.setup?.getClaudeModels) {
        throw new Error('Claude models API not available');
      }
      const result = await api.setup.getClaudeModels(refresh);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch Claude models');
      }
      // Only a real API listing extends the catalog; the static fallback is
      // already covered by the canonical alias entries in the UI.
      if (result.source !== 'api') return [];
      return (result.models ?? []) as ModelDefinition[];
    },
    staleTime: STALE_TIMES.MODELS,
    refetchOnMount: refresh ? 'always' : true,
  });
}

/**
 * Fetch Gemini models discovered from the Gemini API.
 * Falls back to the static catalog on the server when no API key is configured.
 */
export function useGeminiModels(refresh = false) {
  return useQuery({
    queryKey: queryKeys.models.gemini(),
    queryFn: async (): Promise<ModelDefinition[]> => {
      const api = getElectronAPI();
      if (!api.setup?.getGeminiModels) {
        throw new Error('Gemini models API not available');
      }
      const result = await api.setup.getGeminiModels(refresh);
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch Gemini models');
      }
      // Static fallback equals the built-in GEMINI_MODELS list the UI already has.
      if (result.source !== 'api') return [];
      return (result.models ?? []) as ModelDefinition[];
    },
    staleTime: STALE_TIMES.MODELS,
    refetchOnMount: refresh ? 'always' : true,
  });
}

/**
 * Fetch OpenCode providers
 *
 * @returns Query result with OpenCode providers
 */
export function useOpencodeProviders() {
  return useQuery({
    queryKey: queryKeys.models.opencodeProviders(),
    queryFn: async () => {
      const api = getElectronAPI();
      if (!api.setup?.getOpencodeProviders) {
        throw new Error('OpenCode providers API not available');
      }
      const result = await api.setup.getOpencodeProviders();
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch OpenCode providers');
      }
      return result.providers ?? [];
    },
    staleTime: STALE_TIMES.MODELS,
  });
}

/**
 * Fetch model providers status
 *
 * @returns Query result with provider status
 */
export function useModelProviders() {
  return useQuery({
    queryKey: queryKeys.models.providers(),
    queryFn: async () => {
      const api = getElectronAPI();
      if (!api.model) {
        throw new Error('Model API not available');
      }
      const result = await api.model.checkProviders();
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch providers');
      }
      return result.providers ?? {};
    },
    staleTime: STALE_TIMES.MODELS,
  });
}
