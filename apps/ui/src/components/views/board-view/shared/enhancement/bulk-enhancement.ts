import type { EnhancementMode } from '@aboardai/types';
import { isAdditiveMode } from './enhancement-constants';

export interface BulkEnhancementFeature {
  id: string;
  description: string;
}

export interface BulkEnhancementProgress {
  completed: number;
  total: number;
  failed: number;
}

export interface BulkEnhancementFailure {
  featureId: string;
  error: string;
}

export interface BulkEnhancementResult {
  succeededIds: string[];
  failures: BulkEnhancementFailure[];
}

interface EnhanceResult {
  success: boolean;
  enhancedText?: string;
  error?: string;
}

interface SaveResult {
  success: boolean;
  error?: string;
}

interface RunBulkEnhancementOptions<TFeature extends BulkEnhancementFeature> {
  features: TFeature[];
  mode: EnhancementMode;
  concurrency?: number;
  enhance: (feature: TFeature) => Promise<EnhanceResult>;
  save: (feature: TFeature, description: string) => Promise<SaveResult>;
  onProgress?: (progress: BulkEnhancementProgress) => void;
}

export function composeEnhancedDescription(
  originalText: string,
  generatedText: string,
  mode: EnhancementMode
): string {
  return isAdditiveMode(mode) ? `${originalText.trim()}\n\n${generatedText.trim()}` : generatedText;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Enhancement failed';
}

export async function runBulkEnhancement<TFeature extends BulkEnhancementFeature>({
  features,
  mode,
  concurrency = 2,
  enhance,
  save,
  onProgress,
}: RunBulkEnhancementOptions<TFeature>): Promise<BulkEnhancementResult> {
  const succeededIndices: number[] = [];
  const failureEntries: Array<{ index: number; failure: BulkEnhancementFailure }> = [];
  const workerCount = Math.min(features.length, Math.max(1, Math.floor(concurrency)));
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;

  const runWorker = async () => {
    while (nextIndex < features.length) {
      const index = nextIndex;
      nextIndex += 1;
      const feature = features[index];

      try {
        const enhancement = await enhance(feature);
        if (!enhancement.success) {
          throw new Error(enhancement.error || 'Failed to enhance feature');
        }
        if (!enhancement.enhancedText?.trim()) {
          throw new Error('AI returned an empty description');
        }

        const description = composeEnhancedDescription(
          feature.description,
          enhancement.enhancedText,
          mode
        );
        const saveResult = await save(feature, description);
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save feature');
        }

        succeededIndices.push(index);
      } catch (error) {
        failed += 1;
        failureEntries.push({
          index,
          failure: { featureId: feature.id, error: errorMessage(error) },
        });
      } finally {
        completed += 1;
        onProgress?.({ completed, total: features.length, failed });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    succeededIds: succeededIndices
      .sort((left, right) => left - right)
      .map((index) => features[index].id),
    failures: failureEntries
      .sort((left, right) => left.index - right.index)
      .map(({ failure }) => failure),
  };
}
