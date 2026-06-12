/**
 * FakeProvider — test double for ProviderSupervisor fault-injection harness
 *
 * Supports scripted sequences of directives (messages, stalls, throws, end) to
 * simulate any combination of stream failures and recoveries. Works with
 * vi.useFakeTimers() because delays are implemented via setTimeout-based sleep.
 */

import { BaseProvider } from '@/providers/base-provider.js';
import type {
  ExecuteOptions,
  ProviderMessage,
  InstallationStatus,
  ModelDefinition,
} from '@aboardai/types';

// ---------------------------------------------------------------------------
// Directive types
// ---------------------------------------------------------------------------

export type FakeDirective =
  | { kind: 'message'; message: ProviderMessage; delayMs?: number }
  | { kind: 'stall'; ms: number } // emit nothing for ms (fake-timer compatible)
  | { kind: 'throw'; error: Error } // generator throws mid-flight
  | { kind: 'end' }; // generator returns cleanly

export interface FakeRun {
  directives: FakeDirective[];
}

// ---------------------------------------------------------------------------
// Sleep helper — uses setTimeout so vi.advanceTimersByTimeAsync() drives it
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// FakeProvider
// ---------------------------------------------------------------------------

/**
 * Concrete BaseProvider that replays scripted FakeRun sequences.
 *
 * Construction: `new FakeProvider([run0, run1, ...])`
 * - run[N] is replayed on the N-th call to executeQuery()
 * - If more executeQuery() calls arrive than runs provided, the last run repeats
 * - Recorded options (including sdkSessionId) are available via getRecordedOptions()
 */
export class FakeProvider extends BaseProvider {
  private readonly runs: FakeRun[];
  private runIndex = 0;
  private readonly recordedOptions: ExecuteOptions[] = [];
  private closedEarlyCount = 0;

  constructor(runs: FakeRun[]) {
    super({});
    this.runs = runs;
  }

  getName(): string {
    return 'fake';
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return { installed: true, method: 'sdk' };
  }

  getAvailableModels(): ModelDefinition[] {
    return [
      {
        id: 'fake-model-1',
        name: 'Fake Model 1',
        modelString: 'fake-model-1',
        provider: 'fake',
        description: 'A fake model for testing',
      },
    ];
  }

  /** Returns a copy of all recorded ExecuteOptions per call, in order. */
  getRecordedOptions(): ExecuteOptions[] {
    return [...this.recordedOptions];
  }

  /** Returns the recorded options for a specific call (0-indexed). */
  getRecordedOptionsForRun(index: number): ExecuteOptions | undefined {
    return this.recordedOptions[index];
  }

  /** How many times executeQuery has been called so far. */
  getCallCount(): number {
    return this.recordedOptions.length;
  }

  /**
   * How many runs were closed EARLY via .return()/.throw() from the consumer
   * (i.e., neither completed their script nor threw a scripted error).
   */
  getClosedEarlyCount(): number {
    return this.closedEarlyCount;
  }

  async *executeQuery(options: ExecuteOptions): AsyncGenerator<ProviderMessage> {
    // Record the options this call received
    this.recordedOptions.push({ ...options });

    // Pick the run to replay (clamp to last run if we've exceeded the list)
    const runIdx = Math.min(this.runIndex, this.runs.length - 1);
    this.runIndex++;
    const run = this.runs[runIdx];

    // Track whether the run finished on its own terms (script end or scripted
    // throw). If the finally runs without `finished`, the consumer closed the
    // generator early via .return() — record it.
    let finished = false;
    try {
      for (const directive of run.directives) {
        switch (directive.kind) {
          case 'message': {
            if (directive.delayMs && directive.delayMs > 0) {
              await sleep(directive.delayMs);
            }
            yield directive.message;
            break;
          }

          case 'stall': {
            // Sleep for the full stall duration without yielding anything
            await sleep(directive.ms);
            break;
          }

          case 'throw': {
            finished = true;
            throw directive.error;
          }

          case 'end': {
            // Explicit clean end — just return
            finished = true;
            return;
          }
        }
      }
      finished = true;
    } finally {
      if (!finished) {
        this.closedEarlyCount++;
      }
    }
  }
}
