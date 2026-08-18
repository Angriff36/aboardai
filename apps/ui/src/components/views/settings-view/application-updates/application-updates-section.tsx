import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, RefreshCw, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AppUpdateStatus } from '@/types/app-update';

const fallbackStatus: AppUpdateStatus = {
  state: 'unsupported',
  currentVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
  message: 'Update checks are available in the installed desktop app.',
};

export function ApplicationUpdatesSection() {
  const [status, setStatus] = useState<AppUpdateStatus>(fallbackStatus);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getUpdateStatus || !api.onUpdateStatus) return;

    let mounted = true;
    void api.getUpdateStatus().then((nextStatus) => {
      if (mounted) setStatus(nextStatus);
    });
    const unsubscribe = api.onUpdateStatus((nextStatus) => {
      if (mounted) setStatus(nextStatus);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const runAction = useCallback(async (action: 'check' | 'download' | 'install') => {
    const api = window.electronAPI;
    try {
      if (action === 'check' && api?.checkForUpdates) {
        const nextStatus = await api.checkForUpdates();
        if (nextStatus) setStatus(nextStatus);
      } else if (action === 'download' && api?.downloadUpdate) {
        const nextStatus = await api.downloadUpdate();
        if (nextStatus) setStatus(nextStatus);
      } else if (action === 'install' && api?.installUpdate) {
        await api.installUpdate();
      }
    } catch {
      setStatus((current) => ({
        ...current,
        state: 'error',
        message: 'The update action failed. Try again.',
      }));
    }
  }, []);

  const isChecking = status.state === 'checking';
  const isDownloading = status.state === 'downloading';
  const isUnsupported = status.state === 'unsupported';
  const isSuccess = status.state === 'current' || status.state === 'downloaded';
  const isError = status.state === 'error';

  return (
    <div
      className={cn(
        'rounded-2xl overflow-hidden border border-border/50',
        'bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl shadow-sm'
      )}
      data-testid="application-updates-section"
    >
      <div className="p-6 border-b border-border/50 bg-gradient-to-r from-brand-500/5 via-transparent to-transparent">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500/20 to-brand-600/10 flex items-center justify-center border border-brand-500/20">
            <Rocket className="w-5 h-5 text-brand-500" />
          </div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            Application Updates
          </h2>
        </div>
        <p className="text-sm text-muted-foreground/80 ml-12">
          Check, download, and install desktop releases when you choose.
        </p>
      </div>

      <div className="p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-muted/30 border border-border/30">
          <div className="min-w-0">
            <p className="font-medium text-foreground">Installed version {status.currentVersion}</p>
            {status.availableVersion && (
              <p className="text-xs text-brand-400 mt-1">
                Latest release: {status.availableVersion}
              </p>
            )}
          </div>

          {(status.state === 'idle' || status.state === 'current' || status.state === 'error') && (
            <Button
              variant="outline"
              onClick={() => void runAction('check')}
              loading={isChecking}
              disabled={isUnsupported}
            >
              <RefreshCw className="w-4 h-4" />
              Check for updates
            </Button>
          )}

          {status.state === 'checking' && (
            <Button variant="outline" loading disabled>
              Checking…
            </Button>
          )}

          {status.state === 'available' && (
            <Button onClick={() => void runAction('download')}>
              <Download className="w-4 h-4" />
              Download update
            </Button>
          )}

          {isDownloading && (
            <Button loading disabled>
              Downloading {status.downloadPercent ?? 0}%
            </Button>
          )}

          {status.state === 'downloaded' && (
            <Button onClick={() => void runAction('install')}>
              <Rocket className="w-4 h-4" />
              Install and restart
            </Button>
          )}
        </div>

        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm',
            isError
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : isSuccess
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
                : 'border-border/30 bg-background/30 text-muted-foreground'
          )}
          role={isError ? 'alert' : 'status'}
        >
          {isError ? (
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          ) : isSuccess ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <RefreshCw className={cn('w-4 h-4 mt-0.5 shrink-0', isChecking && 'animate-spin')} />
          )}
          <span>{status.message}</span>
        </div>

        <p className="text-xs text-muted-foreground/60">
          AboardAI never downloads an update or restarts the app without your click.
        </p>
      </div>
    </div>
  );
}
