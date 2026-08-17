import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, ModelAssignmentCandidate } from '@aboardai/types';
import { BalanceModelsDialog } from '@/components/views/board-view/dialogs/balance-models-dialog';
import { useFeatureModelCatalog } from '@/components/views/settings-view/model-defaults/use-feature-model-catalog';
import { getHttpApiClient } from '@/lib/http-api-client';

vi.mock('@/components/views/settings-view/model-defaults/use-feature-model-catalog');
vi.mock('@/lib/http-api-client');

const cursor: ModelAssignmentCandidate = {
  key: 'cursor:cursor-auto',
  model: 'cursor-auto',
  displayName: 'Cursor Auto',
  providerKey: 'cursor',
  providerLabel: 'Cursor',
  isProviderDefault: true,
};
const codex: ModelAssignmentCandidate = {
  key: 'codex:codex-gpt-5.2-codex',
  model: 'codex-gpt-5.2-codex',
  displayName: 'GPT-5.2 Codex',
  providerKey: 'codex',
  providerLabel: 'Codex',
  reasoningEffort: 'high',
  isProviderDefault: true,
};
const openrouter: ModelAssignmentCandidate = {
  key: 'provider:openrouter:openrouter/model',
  model: 'openrouter/model',
  displayName: 'OpenRouter Model',
  providerKey: 'claude-compatible:openrouter',
  providerLabel: 'OpenRouter',
  providerId: 'openrouter',
  isProviderDefault: true,
};
const features = [
  { id: 'f1', title: 'First', status: 'backlog' },
  { id: 'f2', title: 'Second', status: 'backlog' },
  { id: 'f3', title: 'Third', status: 'backlog' },
] as Feature[];

describe('BalanceModelsDialog', () => {
  const verifyAccess = vi.fn();
  const setProviderEnabled = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeatureModelCatalog).mockReturnValue({
      candidates: [cursor, codex],
      groups: [
        { key: 'cursor', label: 'Cursor', enabled: true, candidates: [cursor] },
        { key: 'codex', label: 'Codex', enabled: true, candidates: [codex] },
      ],
      setProviderEnabled,
      isLoading: false,
      error: null,
    });
    vi.mocked(getHttpApiClient).mockReturnValue({
      model: { verifyAccess },
    } as ReturnType<typeof getHttpApiClient>);
  });

  it('defaults to automatic and cannot apply until all candidates are verified', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    verifyAccess.mockResolvedValue({
      results: [
        { key: cursor.key, status: 'verified' },
        { key: codex.key, status: 'verified' },
      ],
    });

    render(
      <BalanceModelsDialog
        open
        projectPath="C:\\project"
        features={features}
        onOpenChange={vi.fn()}
        onUpdateFeature={update}
        onComplete={vi.fn()}
      />
    );

    expect(screen.getByRole('radio', { name: 'Automatic' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply Distribution' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Toggle Codex models' }));

    await user.click(screen.getByRole('button', { name: 'Verify Models' }));

    expect(await screen.findByText('2 features')).toBeInTheDocument();
    expect(screen.getByText('1 feature')).toBeInTheDocument();
    expect(screen.getAllByText('Verified')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Apply Distribution' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Apply Distribution' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
    expect(update).toHaveBeenNthCalledWith(
      1,
      'f1',
      expect.objectContaining({ model: cursor.model })
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      'f2',
      expect.objectContaining({ model: codex.model })
    );
  });

  it('allows multiple manual choices and invalidates verification when selection changes', async () => {
    const user = userEvent.setup();
    verifyAccess.mockResolvedValue({
      results: [
        { key: cursor.key, status: 'verified' },
        { key: codex.key, status: 'verified' },
      ],
    });
    render(
      <BalanceModelsDialog
        open
        projectPath="C:\\project"
        features={features}
        onOpenChange={vi.fn()}
        onUpdateFeature={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    await user.click(screen.getByRole('radio', { name: 'Manual' }));
    await user.click(screen.getByRole('checkbox', { name: 'Cursor · Cursor Auto' }));
    await user.click(screen.getByRole('button', { name: 'Toggle Codex models' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex · GPT-5.2 Codex' }));
    await user.click(screen.getByRole('button', { name: 'Verify Models' }));
    expect(await screen.findByRole('button', { name: 'Apply Distribution' })).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Codex · GPT-5.2 Codex' }));
    expect(screen.getByRole('button', { name: 'Apply Distribution' })).toBeDisabled();
    expect(screen.queryByText('2 features')).not.toBeInTheDocument();
  });

  it('collapses models by provider and can globally enable a disabled provider', async () => {
    const user = userEvent.setup();
    vi.mocked(useFeatureModelCatalog).mockReturnValue({
      candidates: [cursor, codex],
      groups: [
        { key: 'cursor', label: 'Cursor', enabled: true, candidates: [cursor] },
        { key: 'codex', label: 'Codex', enabled: true, candidates: [codex] },
        {
          key: 'claude-compatible:openrouter',
          label: 'OpenRouter',
          enabled: false,
          candidates: [openrouter],
          customProviderId: 'openrouter',
        },
      ],
      setProviderEnabled,
      isLoading: false,
      error: null,
    });

    render(
      <BalanceModelsDialog
        open
        projectPath="C:\\project"
        features={features}
        onOpenChange={vi.fn()}
        onUpdateFeature={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Toggle Cursor models' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Toggle Codex models' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('OpenRouter Model')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Use OpenRouter' }));
    expect(setProviderEnabled).toHaveBeenCalledWith('claude-compatible:openrouter', true);
  });

  it('bulk-applies a verified orchestrated team to every selected feature', async () => {
    const user = userEvent.setup();
    const lead: ModelAssignmentCandidate = {
      ...codex,
      key: 'codex:gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    };
    const reviewer: ModelAssignmentCandidate = {
      ...cursor,
      key: 'cursor:grok-4.6',
      model: 'cursor-grok-4.6',
      displayName: 'Cursor Grok 4.6',
    };
    const workhorse: ModelAssignmentCandidate = {
      ...cursor,
      key: 'cursor:composer-2.5',
      model: 'cursor-composer-2.5',
      displayName: 'Composer 2.5',
      isProviderDefault: false,
    };
    vi.mocked(useFeatureModelCatalog).mockReturnValue({
      candidates: [lead, reviewer, workhorse],
      groups: [
        { key: 'codex', label: 'Codex', enabled: true, candidates: [lead] },
        { key: 'cursor', label: 'Cursor', enabled: true, candidates: [reviewer, workhorse] },
      ],
      setProviderEnabled,
      isLoading: false,
      error: null,
    });
    verifyAccess.mockResolvedValue({
      results: [lead, reviewer, workhorse].map((candidate) => ({
        key: candidate.key,
        status: 'verified',
      })),
    });
    const update = vi.fn().mockResolvedValue(undefined);

    render(
      <BalanceModelsDialog
        open
        projectPath="C:\\project"
        features={features}
        onOpenChange={vi.fn()}
        onUpdateFeature={update}
        onComplete={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Assign orchestrated teams' }));
    await user.click(screen.getByRole('button', { name: 'Verify roles' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply Orchestrated Teams' })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: 'Apply Orchestrated Teams' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(features.length));
    expect(update).toHaveBeenCalledWith(
      'f1',
      expect.objectContaining({
        executionMode: 'orchestrated',
        orchestration: expect.objectContaining({
          maxReviewRounds: 5,
          lead: expect.any(Object),
          workhorse: expect.any(Object),
          reviewer: expect.any(Object),
        }),
      })
    );
  });
});
