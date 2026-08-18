import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type AutoUpdaterAdapter } from '@/electron/updates/update-service';

class FakeUpdater extends EventEmitter implements AutoUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => [] as string[]);
  quitAndInstall = vi.fn();
}

describe('UpdateService', () => {
  it('checks manually without enabling automatic downloads', async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater, { currentVersion: '1.1.1', isPackaged: true });

    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('update-available', { version: '1.2.0' });
      return undefined;
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      state: 'available',
      currentVersion: '1.1.1',
      availableVersion: '1.2.0',
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('downloads only after the user requests it and reports progress', async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater, { currentVersion: '1.1.1', isPackaged: true });
    updater.emit('update-available', { version: '1.2.0' });
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('download-progress', { percent: 42.4 });
      updater.emit('update-downloaded', { version: '1.2.0' });
      return [];
    });

    const updates: string[] = [];
    service.subscribe((status) => updates.push(`${status.state}:${status.downloadPercent ?? ''}`));

    await expect(service.downloadUpdate()).resolves.toMatchObject({
      state: 'downloaded',
      availableVersion: '1.2.0',
    });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updates).toContain('downloading:42');
  });

  it('installs only after a download is ready', () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater, { currentVersion: '1.1.1', isPackaged: true });

    expect(() => service.installUpdate()).toThrow('not ready');
    updater.emit('update-downloaded', { version: '1.2.0' });
    service.installUpdate();

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('explains that update checks require an installed build', async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater, { currentVersion: '1.1.1', isPackaged: false });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      state: 'unsupported',
      message: expect.stringContaining('installed'),
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
