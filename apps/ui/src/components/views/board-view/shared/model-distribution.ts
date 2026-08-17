import type { Feature, ModelAssignmentCandidate, ModelDistributionPreview } from '@aboardai/types';

export function createAutomaticCandidates(
  candidates: readonly ModelAssignmentCandidate[]
): ModelAssignmentCandidate[] {
  const groups = new Map<string, ModelAssignmentCandidate[]>();

  for (const candidate of candidates.filter((item) => item.implementationCapable !== false)) {
    const group = groups.get(candidate.providerKey);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.providerKey, [candidate]);
    }
  }

  return Array.from(groups.values(), (group) => {
    return group.find((candidate) => candidate.isProviderDefault) ?? group[0];
  });
}

export function distributeModels(
  featureIds: readonly string[],
  candidates: readonly ModelAssignmentCandidate[]
): ModelDistributionPreview {
  if (featureIds.length === 0) {
    throw new Error('At least one feature is required');
  }
  if (candidates.length === 0) {
    throw new Error('At least one model is required');
  }

  const counts = candidates.map((candidate) => ({ candidate, count: 0 }));
  const assignments = featureIds.map((featureId, index) => {
    const candidateIndex = index % candidates.length;
    const candidate = candidates[candidateIndex];
    counts[candidateIndex].count += 1;
    return { featureId, candidate };
  });

  return { assignments, counts };
}

export function toFeatureModelPatch(
  candidate: ModelAssignmentCandidate
): Pick<Feature, 'model' | 'providerId' | 'thinkingLevel' | 'reasoningEffort'> {
  return {
    model: candidate.model,
    providerId: candidate.providerId,
    thinkingLevel: candidate.thinkingLevel,
    reasoningEffort: candidate.reasoningEffort,
  };
}
