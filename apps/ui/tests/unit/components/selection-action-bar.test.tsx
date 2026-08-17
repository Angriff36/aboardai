import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectionActionBar } from '@/components/views/board-view/components/selection-action-bar';

describe('SelectionActionBar', () => {
  it('offers bulk enhancement for selected backlog features', async () => {
    const user = userEvent.setup();
    const onEnhance = vi.fn();

    render(
      <SelectionActionBar
        selectedCount={3}
        totalCount={5}
        onEnhance={onEnhance}
        onClear={vi.fn()}
        onSelectAll={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Enhance Selected' }));

    expect(onEnhance).toHaveBeenCalledTimes(1);
  });

  it('offers optional model balancing for selected backlog features', async () => {
    const user = userEvent.setup();
    const onBalanceModels = vi.fn();

    render(
      <SelectionActionBar
        selectedCount={3}
        totalCount={5}
        onBalanceModels={onBalanceModels}
        onClear={vi.fn()}
        onSelectAll={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Balance Models' }));
    expect(onBalanceModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Edit Selected' })).toBeInTheDocument();
  });

  it('does not offer enhancement while selecting approval items', () => {
    render(
      <SelectionActionBar
        selectedCount={2}
        totalCount={2}
        mode="waiting_approval"
        onVerify={vi.fn()}
        onEnhance={vi.fn()}
        onBalanceModels={vi.fn()}
        onClear={vi.fn()}
        onSelectAll={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Enhance Selected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Balance Models' })).not.toBeInTheDocument();
  });
});
