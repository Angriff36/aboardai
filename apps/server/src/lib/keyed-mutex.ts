/**
 * KeyedMutex — per-key promise-chain serialization
 *
 * Each key gets a serial promise chain. Concurrent calls to run() with the
 * same key are queued behind the previous call's promise. When a key's chain
 * settles with no further waiters the map entry is deleted (no unbounded growth).
 *
 * Different keys run fully in parallel.
 */

export class KeyedMutex {
  /** Map from key → tail of the current chain (never rejects — all errors absorbed) */
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Run `fn` exclusively under `key`. Concurrent calls with the same key are
   * serialized; concurrent calls with different keys run in parallel.
   *
   * If `fn` throws or rejects the lock is released and the rejection propagates
   * to the caller of run().
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // The previous tail (or a resolved promise if this is the first waiter).
    const previous = this.chains.get(key) ?? Promise.resolve();

    // Build a new tail that:
    //   1. Waits for the previous work to finish (ignoring its outcome).
    //   2. Executes fn and captures the result / error.
    //   3. Never itself rejects (so the chain never terminates early).
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason: unknown) => void;
    const resultPromise = new Promise<T>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const next: Promise<void> = previous.then(async () => {
      try {
        resolveResult(await fn());
      } catch (err) {
        rejectResult(err);
      }
    });

    // Only store the tail if this waiter is still live. After the work runs we
    // delete the entry if our tail is still the current chain tail — meaning no
    // further waiters arrived in the meantime.
    this.chains.set(key, next);
    next.then(() => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });

    return resultPromise;
  }

  /**
   * Number of keys with active or queued work.
   * Exposed for test-only introspection; do not rely on this in production.
   */
  get size(): number {
    return this.chains.size;
  }
}
