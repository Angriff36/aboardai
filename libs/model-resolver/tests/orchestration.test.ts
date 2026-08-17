import { describe, expect, it } from 'vitest';
import type { ModelAssignmentCandidate } from '@aboardai/types';
import {
  selectOrchestrationRoles,
  validateOrchestrationAssignments,
} from '../src/orchestration.js';

function candidate(
  key: string,
  providerKey: string,
  model: string,
  displayName = model
): ModelAssignmentCandidate {
  return {
    key,
    providerKey,
    providerLabel: providerKey,
    model,
    displayName,
    isProviderDefault: false,
    implementationCapable: true,
  };
}

describe('selectOrchestrationRoles', () => {
  it('selects a high-end lead, a lesser workhorse, and a cross-provider high-end reviewer', () => {
    const result = selectOrchestrationRoles([
      candidate('claude:fable', 'claude', 'claude-fable-5', 'Claude Fable 5'),
      candidate('claude:sonnet', 'claude', 'claude-sonnet-4-6', 'Claude Sonnet 4.6'),
      candidate('codex:sol', 'codex', 'gpt-5.6-sol', 'GPT-5.6 Sol'),
      candidate('codex:terra', 'codex', 'gpt-5.6-terra', 'GPT-5.6 Terra'),
      candidate('cursor:grok', 'cursor', 'cursor-grok-4.6', 'Cursor Grok 4.6'),
      candidate('cursor:composer', 'cursor', 'cursor-composer-2.5', 'Composer 2.5'),
    ]);

    expect(result.lead.key).toBe('claude:fable');
    expect(result.reviewer.providerKey).not.toBe(result.lead.providerKey);
    expect(result.workhorse.key).not.toBe(result.lead.key);
    expect(result.maxReviewRounds).toBe(5);
  });

  it('automatically prefers the newest discovered version in a model family', () => {
    const result = selectOrchestrationRoles([
      candidate('claude:opus', 'claude', 'claude-opus-5.1'),
      candidate('codex:sol-old', 'codex', 'gpt-5.6-sol'),
      candidate('codex:sol-new', 'codex', 'gpt-5.7-sol'),
      candidate('cursor:composer', 'cursor', 'cursor-composer-2.5'),
    ]);

    expect([result.lead.key, result.reviewer.key]).toContain('codex:sol-new');
    expect([result.lead.key, result.reviewer.key]).not.toContain('codex:sol-old');
  });

  it('ignores disabled or non-implementation-capable candidates', () => {
    const disabled = candidate('claude:fable', 'claude', 'claude-fable-9');
    disabled.implementationCapable = false;
    const result = selectOrchestrationRoles([
      disabled,
      candidate('claude:opus', 'claude', 'claude-opus-5'),
      candidate('codex:sol', 'codex', 'gpt-5.6-sol'),
      candidate('cursor:composer', 'cursor', 'cursor-composer-2.5'),
    ]);

    expect(result.lead.key).not.toBe(disabled.key);
  });

  it('refuses orchestration when no cross-provider high-end reviewer exists', () => {
    expect(() =>
      selectOrchestrationRoles([
        candidate('claude:fable', 'claude', 'claude-fable-5'),
        candidate('claude:opus', 'claude', 'claude-opus-5'),
        candidate('cursor:composer', 'cursor', 'cursor-composer-2.5'),
      ])
    ).toThrow(/cross-provider reviewer/i);
  });
});

describe('validateOrchestrationAssignments', () => {
  it('rejects same-provider lead and reviewer assignments', () => {
    const lead = candidate('claude:fable', 'claude', 'claude-fable-5');
    const reviewer = candidate('claude:opus', 'claude', 'claude-opus-5');
    const workhorse = candidate('codex:terra', 'codex', 'gpt-5.6-terra');

    expect(() =>
      validateOrchestrationAssignments({ lead, workhorse, reviewer, maxReviewRounds: 5 })
    ).toThrow(/different providers/i);
  });

  it('clamps review rounds to the supported one-to-five range', () => {
    const lead = candidate('claude:fable', 'claude', 'claude-fable-5');
    const reviewer = candidate('codex:sol', 'codex', 'gpt-5.6-sol');
    const workhorse = candidate('cursor:composer', 'cursor', 'cursor-composer-2.5');

    expect(
      validateOrchestrationAssignments({ lead, workhorse, reviewer, maxReviewRounds: 99 })
        .maxReviewRounds
    ).toBe(5);
  });
});
