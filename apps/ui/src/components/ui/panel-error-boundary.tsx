import { Component, type ReactNode, type ErrorInfo } from 'react';
import { createLogger } from '@aboardai/utils/logger';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const logger = createLogger('PanelErrorBoundary');

interface Props {
  children: ReactNode;
  /** Short human label for what crashed, e.g. "Trajectory" — used in the fallback copy and logs. */
  label?: string;
  /**
   * When any value in this array changes, a tripped boundary auto-resets and retries rendering.
   * Pass things like the active view mode / feature id so switching tabs clears a stale crash.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /** Optional callback fired when the user (or a resetKeys change) recovers the panel. */
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Panel-scoped error boundary.
 *
 * Unlike {@link AppErrorBoundary} (which reloads the whole window) this contains a
 * render error to a single content panel. The surrounding chrome — modal header,
 * view tabs, close button — stays mounted and interactive, so the user can switch
 * views or close the dialog instead of being forced to kill the window.
 *
 * Recovery paths:
 *  - "Try again" button resets the boundary in place.
 *  - Any change to `resetKeys` (e.g. switching the active tab) auto-resets it.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(`${this.props.label ?? 'Panel'} crashed:`, {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  componentDidUpdate(prevProps: Props) {
    if (!this.state.hasError) return;
    if (this.resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  private resetKeysChanged(
    prev: ReadonlyArray<unknown> | undefined,
    next: ReadonlyArray<unknown> | undefined
  ): boolean {
    if (prev === next) return false;
    if (!prev || !next || prev.length !== next.length) return true;
    return prev.some((value, i) => !Object.is(value, next[i]));
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const label = this.props.label ?? 'This view';
      return (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="panel-error-boundary"
        >
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-destructive" />
          </div>
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">{label} couldn’t be shown</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              A rendering error occurred in this panel. Other tabs still work, and you can close
              this dialog normally. Try again to re-render this view.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={this.reset} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Try again
          </Button>
          {this.state.error && (
            <details className="text-xs text-muted-foreground max-w-md w-full">
              <summary className="cursor-pointer hover:text-foreground">Technical details</summary>
              <pre className="mt-2 p-3 bg-muted/50 rounded-md text-left overflow-auto max-h-32 border border-border">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
