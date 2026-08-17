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

  it('does not offer enhancement while selecting approval items', () => {
    render(
      <SelectionActionBar
        selectedCount={2}
        totalCount={2}
        mode="waiting_approval"
        onVerify={vi.fn()}
        onEnhance={vi.fn()}
        onClear={vi.fn()}
        onSelectAll={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Enhance Selected' })).not.toBeInTheDocument();
  });
});
