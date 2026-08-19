import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createLogger } from '@aboardai/utils/logger';
import { IPC_CHANNELS } from '../ipc/channels';
import { UpdateService } from './update-service';

const logger = createLogger('UpdateManager');

export const updateService = new UpdateService(autoUpdater, {
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
});

updateService.subscribe((status) => {
  logger.info('Update status:', status.state, status.availableVersion ?? '');
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.UPDATE.STATUS_CHANGED, status);
  }
});
