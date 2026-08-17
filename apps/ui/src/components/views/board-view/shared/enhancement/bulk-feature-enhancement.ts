import type { EnhancementMode, ModelId, ThinkingLevel } from '@aboardai/types';
import {
  runBulkEnhancement,
  type BulkEnhancementFeature,
  type BulkEnhancementProgress,
  type BulkEnhancementResult,
} from './bulk-enhancement';

export interface BulkEnhanceRunOptions {
  mode: EnhancementMode;
  model: ModelId;
  thinkingLevel?: ThinkingLevel;
}

interface EnhancementResponse {
  success: boolean;
  enhancedText?: string;
  error?: string;
}

interface FeatureUpdateResponse {
  success: boolean;
  error?: string;
}

interface ExecuteBulkFeatureEnhancementOptions<TFeature extends BulkEnhancementFeature> {
  projectPath: string;
  features: TFeature[];
  featureIds?: string[];
  options: BulkEnhanceRunOptions;
  enhance: (
    originalText: string,
    enhancementMode: EnhancementMode,
    model?: string,
    thinkingLevel?: ThinkingLevel,
    projectPath?: string
  ) => Promise<EnhancementResponse>;
  update: (
    projectPath: string,
    featureId: string,
    updates: { description: string },
    descriptionHistorySource: 'enhance',
    enhancementMode: EnhancementMode,
    preEnhancementDescription: string
  ) => Promise<FeatureUpdateResponse>;
  onProgress?: (progress: BulkEnhancementProgress) => void;
}

export function executeBulkFeatureEnhancement<TFeature extends BulkEnhancementFeature>({
  projectPath,
  features,
  featureIds,
  options,
  enhance,
  update,
  onProgress,
}: ExecuteBulkFeatureEnhancementOptions<TFeature>): Promise<BulkEnhancementResult> {
  const retryIds = featureIds ? new Set(featureIds) : null;
  const targetFeatures = retryIds
    ? features.filter((feature) => retryIds.has(feature.id))
    : features;

  return runBulkEnhancement({
    features: targetFeatures,
    mode: options.mode,
    enhance: (feature) =>
      enhance(feature.description, options.mode, options.model, options.thinkingLevel, projectPath),
    save: (feature, description) =>
      update(
        projectPath,
        feature.id,
        { description },
        'enhance',
        options.mode,
        feature.description
      ),
    onProgress,
  });
}
