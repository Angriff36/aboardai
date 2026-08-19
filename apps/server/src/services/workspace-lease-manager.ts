import path from 'node:path';

interface Waiter {
  featureId: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface LeaseState {
  ownerFeatureId: string;
  count: number;
  waiters: Waiter[];
}

const abortError = (): Error => {
  const error = new Error('Workspace lease acquisition was aborted');
  error.name = 'AbortError';
  return error;
};

export function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
  if (isWindowsPath) {
    return path.win32
      .normalize(trimmed.replaceAll('/', '\\'))
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  }
  return path.resolve(trimmed).replace(/[\\/]+$/, '');
}

export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, LeaseState>();

  async acquire(
    workspacePath: string,
    featureId: string,
    signal?: AbortSignal
  ): Promise<() => void> {
    if (signal?.aborted) throw abortError();

    const key = normalizeWorkspacePath(workspacePath);
    const lease = this.leases.get(key);
    if (!lease) {
      this.leases.set(key, { ownerFeatureId: featureId, count: 1, waiters: [] });
      return this.createRelease(key, featureId);
    }

    if (lease.ownerFeatureId === featureId) {
      lease.count += 1;
      return this.createRelease(key, featureId);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { featureId, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const current = this.leases.get(key);
          if (!current) return;
          const index = current.waiters.indexOf(waiter);
          if (index === -1) return;
          current.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      lease.waiters.push(waiter);
    });
  }

  private createRelease(key: string, featureId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(key, featureId);
    };
  }

  private release(key: string, featureId: string): void {
    const lease = this.leases.get(key);
    if (!lease || lease.ownerFeatureId !== featureId) return;

    lease.count -= 1;
    if (lease.count > 0) return;

    const next = lease.waiters.shift();
    if (!next) {
      this.leases.delete(key);
      return;
    }

    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    lease.ownerFeatureId = next.featureId;
    lease.count = 1;
    next.resolve(this.createRelease(key, next.featureId));
  }
}

export const workspaceLeaseManager = new WorkspaceLeaseManager();
