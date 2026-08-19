export type AppUpdateState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export interface AppUpdateStatus {
  state: AppUpdateState;
  currentVersion: string;
  availableVersion?: string;
  downloadPercent?: number;
  message?: string;
}
