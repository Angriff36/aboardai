import { describe, expect, it, vi } from 'vitest';
import { clearWebUpdateState } from '@/electron/utils/clear-web-update-state';

describe('clearWebUpdateState', () => {
  it('clears only PWA state for the packaged renderer origin', async () => {
    const clearStorageData = vi.fn().mockResolvedValue(undefined);

    await clearWebUpdateState({ clearStorageData }, 'http://localhost:47821');

    expect(clearStorageData).toHaveBeenCalledOnce();
    expect(clearStorageData).toHaveBeenCalledWith({
      origin: 'http://localhost:47821',
      storages: ['serviceworkers', 'cachestorage'],
    });
  });
});
