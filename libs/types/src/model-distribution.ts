import type { PhaseModelEntry } from './settings.js';

export interface ModelAssignmentCandidate extends PhaseModelEntry {
  key: string;
  displayName: string;
  providerKey: string;
  providerLabel: string;
  isProviderDefault: boolean;
  /** False when a model may be selected manually but is not safe for automatic implementation. */
  implementationCapable?: boolean;
}

export type ModelAccessVerificationStatus = 'verified' | 'unavailable';

export interface ModelAccessVerificationResult {
  key: string;
  status: ModelAccessVerificationStatus;
  error?: string;
}

export interface ModelDistributionAssignment {
  featureId: string;
  candidate: ModelAssignmentCandidate;
}

export interface ModelDistributionCount {
  candidate: ModelAssignmentCandidate;
  count: number;
}

export interface ModelDistributionPreview {
  assignments: ModelDistributionAssignment[];
  counts: ModelDistributionCount[];
}
