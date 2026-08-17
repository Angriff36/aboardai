import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { getHttpApiClient } from '@/lib/http-api-client';

vi.mock('@/lib/http-api-client', () => ({
  getHttpApiClient: vi.fn(),
}));

describe('provider visibility persistence', () => {
  const updateGlobal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    updateGlobal.mockResolvedValue({ success: true });
    vi.mocked(getHttpApiClient).mockReturnValue({
      settings: { updateGlobal },
    } as ReturnType<typeof getHttpApiClient>);
    useAppStore.setState({ disabledProviders: [] });
  });

  it('persists built-in provider visibility changes', async () => {
    await useAppStore.getState().toggleProviderDisabled('opencode', true);

    expect(useAppStore.getState().disabledProviders).toEqual(['opencode']);
    expect(updateGlobal).toHaveBeenCalledWith({ disabledProviders: ['opencode'] });
  });
});
