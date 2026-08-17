import type { ModelAssignmentCandidate, OrchestrationModelAssignment } from '@aboardai/types';

export interface OrchestrationAssignments {
  lead: ModelAssignmentCandidate;
  workhorse: ModelAssignmentCandidate;
  reviewer: ModelAssignmentCandidate;
  maxReviewRounds: number;
}

const MAX_REVIEW_ROUNDS = 5;
const HIGH_END_THRESHOLD = 450;

function normalizedName(candidate: ModelAssignmentCandidate): string {
  return `${candidate.model} ${candidate.displayName}`.toLowerCase();
}

function versionScore(name: string): number {
  const matches = [...name.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (matches.length === 0) return 0;
  const version = matches.at(-1) ?? 0;
  return Math.min(99, Math.round(version * 10));
}

/**
 * Family-aware score over live-discovered model names. Exact model versions are
 * intentionally not enumerated: a larger discovered version automatically wins
 * within the same family.
 */
export function getOrchestrationModelScore(candidate: ModelAssignmentCandidate): number {
  const name = normalizedName(candidate);
  let familyScore = 100;

  if (/\bfable\b/.test(name)) familyScore = 500;
  else if (/\bsol\b/.test(name)) familyScore = 490;
  else if (/\bopus\b/.test(name)) familyScore = 480;
  else if (/\bgrok\b/.test(name)) familyScore = 470;
  else if (/\bsonnet\b/.test(name)) familyScore = 300;
  else if (/\bterra\b/.test(name)) familyScore = 285;
  else if (/\bcomposer\b/.test(name)) familyScore = 270;
  else if (/\bhaiku\b/.test(name)) familyScore = 180;

  const effortBonus = /\bxhigh\b|high effort/.test(name)
    ? 12
    : /\bhigh\b/.test(name)
      ? 8
      : /\bmedium\b/.test(name)
        ? 4
        : /\blow\b|fast/.test(name)
          ? -4
          : 0;

  return familyScore + versionScore(name) + effortBonus + (candidate.isProviderDefault ? 2 : 0);
}

function eligibleCandidates(
  candidates: readonly ModelAssignmentCandidate[]
): ModelAssignmentCandidate[] {
  return candidates.filter((candidate) => candidate.implementationCapable !== false);
}

function byDescendingScore(
  left: ModelAssignmentCandidate,
  right: ModelAssignmentCandidate
): number {
  return (
    getOrchestrationModelScore(right) - getOrchestrationModelScore(left) ||
    left.key.localeCompare(right.key)
  );
}

export function validateOrchestrationAssignments(
  assignments: OrchestrationAssignments
): OrchestrationAssignments {
  if (assignments.lead.providerKey === assignments.reviewer.providerKey) {
    throw new Error('Lead and reviewer must use different providers');
  }
  if (assignments.lead.key === assignments.reviewer.key) {
    throw new Error('Lead and reviewer must use different model assignments');
  }
  if (getOrchestrationModelScore(assignments.reviewer) < HIGH_END_THRESHOLD) {
    throw new Error('Reviewer must be a high-end model');
  }
  return {
    ...assignments,
    maxReviewRounds: Math.max(1, Math.min(assignments.maxReviewRounds || 5, MAX_REVIEW_ROUNDS)),
  };
}

export function selectOrchestrationRoles(
  candidates: readonly ModelAssignmentCandidate[]
): OrchestrationAssignments {
  const eligible = eligibleCandidates(candidates);
  const highEnd = eligible
    .filter((candidate) => getOrchestrationModelScore(candidate) >= HIGH_END_THRESHOLD)
    .sort(byDescendingScore);
  const lead = highEnd[0];
  if (!lead) throw new Error('No verified high-end lead model is available');

  const reviewer = highEnd.find((candidate) => candidate.providerKey !== lead.providerKey);
  if (!reviewer) throw new Error('No verified cross-provider reviewer is available');

  const lowerTier = eligible.filter(
    (candidate) =>
      candidate.key !== lead.key &&
      candidate.key !== reviewer.key &&
      getOrchestrationModelScore(candidate) < HIGH_END_THRESHOLD
  );
  const workhorsePool =
    lowerTier.length > 0
      ? lowerTier
      : eligible.filter(
          (candidate) => candidate.key !== lead.key && candidate.key !== reviewer.key
        );
  const workhorse = [...workhorsePool].sort((left, right) => {
    const leftDiversity = left.providerKey === lead.providerKey ? 0 : 25;
    const rightDiversity = right.providerKey === lead.providerKey ? 0 : 25;
    return (
      getOrchestrationModelScore(right) +
        rightDiversity -
        (getOrchestrationModelScore(left) + leftDiversity) || left.key.localeCompare(right.key)
    );
  })[0];
  if (!workhorse) throw new Error('No verified workhorse model is available');

  return validateOrchestrationAssignments({
    lead,
    workhorse,
    reviewer,
    maxReviewRounds: MAX_REVIEW_ROUNDS,
  });
}

export function toOrchestrationModelAssignment(
  candidate: ModelAssignmentCandidate
): OrchestrationModelAssignment {
  return {
    candidateKey: candidate.key,
    model: candidate.model,
    displayName: candidate.displayName,
    providerKey: candidate.providerKey,
    providerId: candidate.providerId,
    thinkingLevel: candidate.thinkingLevel,
    reasoningEffort: candidate.reasoningEffort,
  };
}
