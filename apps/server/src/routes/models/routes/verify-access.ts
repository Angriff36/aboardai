import type { Request, Response } from 'express';
import type { ModelAssignmentCandidate, ReasoningEffort, ThinkingLevel } from '@aboardai/types';
import type { SettingsService } from '../../../services/settings-service.js';
import { verifyModelAccess } from '../../../services/model-access-verifier.js';

type VerifyAccess = typeof verifyModelAccess;
const THINKING_LEVELS = new Set<ThinkingLevel>([
  'none',
  'low',
  'medium',
  'high',
  'ultrathink',
  'adaptive',
]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function validateCandidate(value: unknown): value is ModelAssignmentCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== 'string' ||
    candidate.key.trim() === '' ||
    typeof candidate.model !== 'string' ||
    candidate.model.trim() === '' ||
    typeof candidate.displayName !== 'string' ||
    candidate.displayName.trim() === '' ||
    typeof candidate.providerKey !== 'string' ||
    candidate.providerKey.trim() === '' ||
    typeof candidate.providerLabel !== 'string' ||
    candidate.providerLabel.trim() === '' ||
    typeof candidate.isProviderDefault !== 'boolean'
  ) {
    return false;
  }
  if (candidate.providerId !== undefined && typeof candidate.providerId !== 'string') return false;
  if (
    candidate.thinkingLevel !== undefined &&
    !THINKING_LEVELS.has(candidate.thinkingLevel as ThinkingLevel)
  ) {
    return false;
  }
  if (
    candidate.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.has(candidate.reasoningEffort as ReasoningEffort)
  ) {
    return false;
  }
  return true;
}

export function createVerifyAccessHandler(
  settingsService: SettingsService,
  verify: VerifyAccess = verifyModelAccess
) {
  return async (req: Request, res: Response): Promise<void> => {
    const { projectPath, candidates } = req.body ?? {};
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      res.status(400).json({ error: 'projectPath is required' });
      return;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      res.status(400).json({ error: 'At least one candidate is required' });
      return;
    }
    if (candidates.length > 20) {
      res.status(400).json({ error: 'No more than 20 candidates may be verified at once' });
      return;
    }
    if (!candidates.every(validateCandidate)) {
      res
        .status(400)
        .json({ error: 'Every candidate must contain valid key, model, and provider data' });
      return;
    }
    if (new Set(candidates.map((candidate) => candidate.key)).size !== candidates.length) {
      res.status(400).json({ error: 'Candidate keys must be unique' });
      return;
    }

    try {
      const results = await verify(candidates, projectPath, settingsService);
      res.json({ results });
    } catch {
      res.status(500).json({ error: 'Model verification could not be completed' });
    }
  };
}
