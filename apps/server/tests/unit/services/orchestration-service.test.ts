import { describe, expect, it, vi } from 'vitest';
import type {
  Feature,
  OrchestrationModelAssignment,
  OrchestrationRunRecord,
} from '@aboardai/types';
import { OrchestrationService } from '../../../src/services/orchestration-service.js';

const lead: OrchestrationModelAssignment = {
  candidateKey: 'claude:fable',
  model: 'claude-fable-5',
  providerKey: 'claude',
};
const workhorse: OrchestrationModelAssignment = {
  candidateKey: 'cursor:composer',
  model: 'cursor-composer-2.5',
  providerKey: 'cursor',
};
const reviewer: OrchestrationModelAssignment = {
  candidateKey: 'codex:sol',
  model: 'gpt-5.6-sol',
  providerKey: 'codex',
};

const feature: Feature = {
  id: 'feature-1',
  title: 'Ship orchestration',
  description: 'Implement the approved orchestration contract.',
  category: 'Core',
  executionMode: 'orchestrated',
  orchestration: {
    enabled: true,
    selectionMode: 'automatic',
    lead,
    workhorse,
    reviewer,
    maxReviewRounds: 5,
  },
};

function harness(reviewResponses: string[], leadPlanResponse = 'Implementation brief') {
  const calls: string[] = [];
  const savedRuns: OrchestrationRunRecord[] = [];
  let reviewIndex = 0;
  const service = new OrchestrationService({
    verifyAssignments: vi.fn(async () => {
      calls.push('verify');
      return [];
    }),
    queryRole: vi.fn(async (role) => {
      calls.push(role);
      if (role === 'lead-plan') return leadPlanResponse;
      if (role === 'lead-revision') return 'Revised implementation instructions';
      return reviewResponses[reviewIndex++];
    }),
    runWorkhorse: vi.fn(async (_assignment, prompt) => {
      calls.push(
        prompt.includes('Revised implementation instructions') ? 'workhorse-repair' : 'workhorse'
      );
    }),
    runPipeline: vi.fn(async () => {
      calls.push('pipeline');
    }),
    collectEvidence: vi.fn(async () => 'diff and tests'),
    writeArtifact: vi.fn(async () => undefined),
    saveRun: vi.fn(async (record) => {
      savedRuns.push(structuredClone(record));
    }),
    now: () => '2026-08-17T00:00:00.000Z',
  });
  return { service, calls, savedRuns };
}

describe('OrchestrationService', () => {
  it('requires reviewer approval after implementation and tests', async () => {
    const { service, calls } = harness([
      JSON.stringify({ verdict: 'approve', summary: 'Ready', findings: [] }),
    ]);

    const result = await service.execute({ feature, basePrompt: 'Build it' });

    expect(result.approved).toBe(true);
    expect(calls).toEqual(['verify', 'lead-plan', 'workhorse', 'pipeline', 'reviewer']);
    expect(result.run.finalVerdict).toBe('approve');
    expect(result.run.phase).toBe('approved');
  });

  it('returns rejected work to the lead before delegating repairs to the workhorse', async () => {
    const { service, calls } = harness([
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'Missing edge case',
        findings: ['Handle empty input'],
      }),
      JSON.stringify({ verdict: 'approve', summary: 'Fixed', findings: [] }),
    ]);

    const result = await service.execute({ feature, basePrompt: 'Build it' });

    expect(result.approved).toBe(true);
    expect(calls).toEqual([
      'verify',
      'lead-plan',
      'workhorse',
      'pipeline',
      'reviewer',
      'lead-revision',
      'workhorse-repair',
      'pipeline',
      'reviewer',
    ]);
    expect(result.run.currentRound).toBe(2);
  });

  it('stops after five rejected review rounds and preserves work for approval', async () => {
    const rejection = JSON.stringify({
      verdict: 'request_changes',
      summary: 'Still incomplete',
      findings: ['Fix the remaining issue'],
    });
    const { service, calls } = harness(Array.from({ length: 5 }, () => rejection));

    const result = await service.execute({ feature, basePrompt: 'Build it' });

    expect(result.approved).toBe(false);
    expect(result.run.phase).toBe('waiting_approval');
    expect(result.run.currentRound).toBe(5);
    expect(result.run.reviews).toHaveLength(5);
    expect(calls.filter((call) => call === 'lead-revision')).toHaveLength(4);
    expect(calls.filter((call) => call === 'workhorse-repair')).toHaveLength(4);
  });

  it('never approves a malformed reviewer response', async () => {
    const { service } = harness(['looks good to me']);

    const result = await service.execute({ feature, basePrompt: 'Build it' });

    expect(result.approved).toBe(false);
    expect(result.run.phase).toBe('waiting_approval');
    expect(result.run.terminalReason).toMatch(/valid structured verdict/i);
  });

  it('reports a planning provider failure as failed instead of reviewable work', async () => {
    const { service } = harness([], '');

    const result = await service.execute({ feature, basePrompt: 'Build it' });

    expect(result.approved).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.run.phase).toBe('failed');
    expect(result.run.terminalReason).toMatch(/empty implementation brief/i);
  });
});
