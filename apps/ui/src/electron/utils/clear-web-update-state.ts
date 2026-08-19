export type StorageDataSession = Pick<Electron.Session, 'clearStorageData'>;

export async function clearWebUpdateState(
  storageSession: StorageDataSession,
  origin: string
): Promise<void> {
  await storageSession.clearStorageData({
    origin,
    storages: ['serviceworkers', 'cachestorage'],
  });
}
