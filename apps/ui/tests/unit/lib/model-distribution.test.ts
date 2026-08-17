import { describe, expect, it } from 'vitest';
import type { ModelAssignmentCandidate } from '@aboardai/types';
import {
  createAutomaticCandidates,
  distributeModels,
  toFeatureModelPatch,
} from '@/components/views/board-view/shared/model-distribution';

const cursor: ModelAssignmentCandidate = {
  key: 'cursor:cursor-auto',
  model: 'cursor-auto',
  displayName: 'Cursor Auto',
  providerKey: 'cursor',
  providerLabel: 'Cursor',
  isProviderDefault: true,
};

const codex: ModelAssignmentCandidate = {
  key: 'codex:gpt-5.2-codex',
  model: 'codex-gpt-5.2-codex',
  displayName: 'GPT-5.2 Codex',
  providerKey: 'codex',
  providerLabel: 'Codex',
  reasoningEffort: 'high',
  isProviderDefault: true,
};

describe('createAutomaticCandidates', () => {
  it('chooses one default representative per provider without changing provider order', () => {
    const cursorComposer = {
      ...cursor,
      key: 'cursor:composer',
      model: 'cursor-composer-1',
      isProviderDefault: false,
    };
    const cursorDefault = { ...cursor };
    const codexFirst = { ...codex, isProviderDefault: false };

    expect(
      createAutomaticCandidates([cursorComposer, cursorDefault, codexFirst]).map((item) => item.key)
    ).toEqual(['cursor:cursor-auto', 'codex:gpt-5.2-codex']);
  });

  it('keeps provisional models manual-only even when configured as a provider default', () => {
    const provisional: ModelAssignmentCandidate = {
      ...cursor,
      key: 'claude:fable',
      model: 'claude-fable',
      providerKey: 'claude',
      isProviderDefault: true,
      implementationCapable: false,
    };
    const supported: ModelAssignmentCandidate = {
      ...cursor,
      key: 'claude:sonnet',
      model: 'claude-sonnet',
      providerKey: 'claude',
      isProviderDefault: false,
    };

    expect(createAutomaticCandidates([provisional, supported])).toEqual([supported]);
  });
});

describe('distributeModels', () => {
  it('returns a stable round-robin spread while preserving inputs', () => {
    const featureIds = ['f1', 'f2', 'f3'];
    const candidates = [cursor, codex];

    expect(distributeModels(featureIds, candidates)).toEqual({
      assignments: [
        { featureId: 'f1', candidate: cursor },
        { featureId: 'f2', candidate: codex },
        { featureId: 'f3', candidate: cursor },
      ],
      counts: [
        { candidate: cursor, count: 2 },
        { candidate: codex, count: 1 },
      ],
    });
    expect(featureIds).toEqual(['f1', 'f2', 'f3']);
    expect(candidates).toEqual([cursor, codex]);
  });

  it('keeps assignment counts within one feature of each other', () => {
    const third = { ...cursor, key: 'claude:sonnet', providerKey: 'claude' };
    const preview = distributeModels(['1', '2', '3', '4', '5', '6', '7'], [cursor, codex, third]);
    const counts = preview.counts.map((item) => item.count);

    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('rejects empty feature and candidate inputs', () => {
    expect(() => distributeModels([], [cursor])).toThrow('At least one feature is required');
    expect(() => distributeModels(['f1'], [])).toThrow('At least one model is required');
  });
});

describe('toFeatureModelPatch', () => {
  it('sets all persisted model fields so stale provider-specific values are cleared', () => {
    expect(toFeatureModelPatch(cursor)).toEqual({
      model: 'cursor-auto',
      providerId: undefined,
      thinkingLevel: undefined,
      reasoningEffort: undefined,
    });
    expect(toFeatureModelPatch(codex)).toEqual({
      model: 'codex-gpt-5.2-codex',
      providerId: undefined,
      thinkingLevel: undefined,
      reasoningEffort: 'high',
    });
  });
});
