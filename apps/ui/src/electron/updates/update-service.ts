import type { AppUpdateStatus } from '../../types/app-update';

interface UpdateInfoLike {
  version: string;
}

interface DownloadProgressLike {
  percent: number;
}

export interface AutoUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): this;
  on(
    event: 'update-available' | 'update-not-available',
    listener: (info: UpdateInfoLike) => void
  ): this;
  on(event: 'download-progress', listener: (progress: DownloadProgressLike) => void): this;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateServiceOptions {
  currentVersion: string;
  isPackaged: boolean;
}

type StatusListener = (status: AppUpdateStatus) => void;

function friendlyUpdateError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/404|latest\.yml|no published versions|no published release/i.test(detail)) {
    return 'No published AboardAI release is available yet.';
  }
  return 'Could not check for updates. Check your internet connection and try again.';
}

export class UpdateService {
  private readonly listeners = new Set<StatusListener>();
  private status: AppUpdateStatus;

  constructor(
    private readonly updater: AutoUpdaterAdapter,
    private readonly options: UpdateServiceOptions
  ) {
    this.status = {
      state: options.isPackaged ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      message: options.isPackaged
        ? 'Updates are checked only when you ask.'
        : 'Update checks are available in the installed desktop app.',
    };

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.bindUpdaterEvents();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkForUpdates(): Promise<AppUpdateStatus> {
    if (!this.options.isPackaged) {
      return this.getStatus();
    }

    this.setStatus({
      state: 'checking',
      currentVersion: this.options.currentVersion,
      message: 'Checking GitHub for the latest AboardAI release…',
    });

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.setStatus({
        state: 'error',
        currentVersion: this.options.currentVersion,
        message: friendlyUpdateError(error),
      });
    }

    return this.getStatus();
  }

  async downloadUpdate(): Promise<AppUpdateStatus> {
    if (this.status.state !== 'available') {
      throw new Error('An update is not available to download.');
    }

    this.setStatus({
      ...this.status,
      state: 'downloading',
      downloadPercent: 0,
      message: `Downloading AboardAI ${this.status.availableVersion}…`,
    });

    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setStatus({
        ...this.status,
        state: 'error',
        message: friendlyUpdateError(error),
      });
    }

    return this.getStatus();
  }

  installUpdate(): void {
    if (this.status.state !== 'downloaded') {
      throw new Error('The update is not ready to install.');
    }
    this.updater.quitAndInstall(false, true);
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setStatus({
        state: 'checking',
        currentVersion: this.options.currentVersion,
        message: 'Checking GitHub for the latest AboardAI release…',
      });
    });

    this.updater.on('update-available', (info) => {
      this.setStatus({
        state: 'available',
        currentVersion: this.options.currentVersion,
        availableVersion: info.version,
        message: `AboardAI ${info.version} is available.`,
      });
    });

    this.updater.on('update-not-available', () => {
      this.setStatus({
        state: 'current',
        currentVersion: this.options.currentVersion,
        message: 'You are running the latest published version.',
      });
    });

    this.updater.on('download-progress', (progress) => {
      const downloadPercent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.setStatus({
        ...this.status,
        state: 'downloading',
        downloadPercent,
        message: `Downloading update… ${downloadPercent}%`,
      });
    });

    this.updater.on('update-downloaded', (info) => {
      this.setStatus({
        state: 'downloaded',
        currentVersion: this.options.currentVersion,
        availableVersion: info.version,
        downloadPercent: 100,
        message: `AboardAI ${info.version} is ready to install.`,
      });
    });

    this.updater.on('error', (error) => {
      this.setStatus({
        ...this.status,
        state: 'error',
        message: friendlyUpdateError(error),
      });
    });
  }

  private setStatus(status: AppUpdateStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(this.getStatus());
    }
  }
}
