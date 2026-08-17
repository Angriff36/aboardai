import type { ModelDistributionAssignment } from '@aboardai/types';
import { toFeatureModelPatch } from './model-distribution';

export interface AssignmentProgress {
  completed: number;
  total: number;
  failed: number;
}

export interface ApplyModelAssignmentsOptions {
  concurrency?: number;
  onProgress?: (progress: AssignmentProgress) => void;
}

export async function applyModelAssignments(
  assignments: readonly ModelDistributionAssignment[],
  updateFeature: (
    featureId: string,
    patch: ReturnType<typeof toFeatureModelPatch>
  ) => Promise<void>,
  options: ApplyModelAssignmentsOptions = {}
): Promise<{
  succeededIds: string[];
  failed: Array<{ featureId: string; error: string }>;
}> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 5));
  const outcomes = new Array<
    { featureId: string; success: true } | { featureId: string; success: false; error: string }
  >(assignments.length);
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= assignments.length) return;
      const assignment = assignments[index];
      try {
        await updateFeature(assignment.featureId, toFeatureModelPatch(assignment.candidate));
        outcomes[index] = { featureId: assignment.featureId, success: true };
      } catch (error) {
        failed += 1;
        outcomes[index] = {
          featureId: assignment.featureId,
          success: false,
          error: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : 'Update failed',
        };
      } finally {
        completed += 1;
        options.onProgress?.({ completed, total: assignments.length, failed });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, assignments.length) }, () => worker())
  );

  return {
    succeededIds: outcomes.filter((outcome) => outcome.success).map((outcome) => outcome.featureId),
    failed: outcomes
      .filter((outcome): outcome is Extract<(typeof outcomes)[number], { success: false }> =>
        Boolean(outcome && !outcome.success)
      )
      .map(({ featureId, error }) => ({ featureId, error })),
  };
}
