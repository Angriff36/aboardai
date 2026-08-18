import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationUpdatesSection } from '@/components/views/settings-view/application-updates/application-updates-section';
import type { AppUpdateStatus } from '@/types/app-update';

describe('ApplicationUpdatesSection', () => {
  const checkForUpdates = vi.fn();
  const downloadUpdate = vi.fn();
  const installUpdate = vi.fn();
  let listener: ((status: AppUpdateStatus) => void) | undefined;

  beforeEach(() => {
    listener = undefined;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        isElectron: true,
        getUpdateStatus: vi.fn().mockResolvedValue({
          state: 'idle',
          currentVersion: '1.1.1',
        }),
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        onUpdateStatus: vi.fn((callback: (status: AppUpdateStatus) => void) => {
          listener = callback;
          return () => undefined;
        }),
      },
    });
  });

  it('shows the installed version and checks only when clicked', async () => {
    checkForUpdates.mockResolvedValue({
      state: 'current',
      currentVersion: '1.1.1',
      message: 'You are running the latest version.',
    });
    render(<ApplicationUpdatesSection />);

    expect(await screen.findByText('Installed version 1.1.1')).toBeInTheDocument();
    expect(checkForUpdates).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(await screen.findByText('You are running the latest version.')).toBeInTheDocument();
  });

  it('offers download and install actions as update state changes', async () => {
    render(<ApplicationUpdatesSection />);
    await screen.findByText('Installed version 1.1.1');

    act(() => {
      listener?.({
        state: 'available',
        currentVersion: '1.1.1',
        availableVersion: '1.2.0',
        message: 'Version 1.2.0 is available.',
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download update' }));
    expect(downloadUpdate).toHaveBeenCalledOnce();

    act(() => {
      listener?.({
        state: 'downloaded',
        currentVersion: '1.1.1',
        availableVersion: '1.2.0',
        message: 'Version 1.2.0 is ready to install.',
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Install and restart' }));
    expect(installUpdate).toHaveBeenCalledOnce();
  });
});
