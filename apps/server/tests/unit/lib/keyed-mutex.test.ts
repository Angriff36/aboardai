import { describe, it, expect, vi } from 'vitest';
import { KeyedMutex } from '@/lib/keyed-mutex.js';

describe('KeyedMutex', () => {
  describe('same key serializes', () => {
    it('second fn does not start before first settles', async () => {
      const mutex = new KeyedMutex();
      const log: string[] = [];

      let resolveFirst!: () => void;
      const firstDone = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const first = mutex.run('key', async () => {
        log.push('first:start');
        await firstDone;
        log.push('first:end');
        return 1;
      });

      // Give the event loop a tick so first can enter
      await Promise.resolve();
      await Promise.resolve();

      let secondStarted = false;
      const second = mutex.run('key', async () => {
        secondStarted = true;
        log.push('second:start');
        return 2;
      });

      // Second must NOT have started yet
      expect(secondStarted).toBe(false);
      expect(log).toEqual(['first:start']);

      resolveFirst();
      const [r1, r2] = await Promise.all([first, second]);

      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(log).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('third call still runs after first throws', async () => {
      const mutex = new KeyedMutex();

      const p1 = mutex.run('k', async () => {
        throw new Error('boom');
      });

      // Swallow the rejection
      await p1.catch(() => {});

      const result = await mutex.run('k', async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('different keys run in parallel', () => {
    it('two different keys resolve without waiting for each other', async () => {
      const mutex = new KeyedMutex();
      const log: string[] = [];

      let resolveA!: () => void;
      const doneA = new Promise<void>((res) => {
        resolveA = res;
      });

      const pA = mutex.run('a', async () => {
        log.push('a:start');
        await doneA;
        log.push('a:end');
      });

      const pB = mutex.run('b', async () => {
        log.push('b:start');
      });

      await pB;

      // B should have run even though A is still held
      expect(log).toContain('b:start');
      expect(log).toContain('a:start');
      expect(log).not.toContain('a:end');

      resolveA();
      await pA;
      expect(log).toContain('a:end');
    });
  });

  describe('error releases the lock', () => {
    it('a throwing fn releases the lock so the next call proceeds', async () => {
      const mutex = new KeyedMutex();

      const throwing = mutex.run('k', async () => {
        throw new Error('intentional');
      });

      await expect(throwing).rejects.toThrow('intentional');

      // Lock must be released
      const result = await mutex.run('k', async () => 42);
      expect(result).toBe(42);
    });

    it('queued call still runs after previous rejects', async () => {
      const mutex = new KeyedMutex();

      let resolveFirst!: (v: void) => void;
      const firstDone = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const first = mutex.run('k', async () => {
        await firstDone;
        throw new Error('err');
      });

      const second = mutex.run('k', async () => 'second ran');

      resolveFirst();
      await first.catch(() => {});
      await expect(second).resolves.toBe('second ran');
    });
  });

  describe('map entry GC (no unbounded growth)', () => {
    it('size drops to 0 after all work settles', async () => {
      const mutex = new KeyedMutex();

      await mutex.run('k1', async () => 1);
      await mutex.run('k2', async () => 2);

      // Allow microtasks to flush the cleanup .then() handlers
      await Promise.resolve();
      await Promise.resolve();

      expect(mutex.size).toBe(0);
    });

    it('size is 0 after a key with two queued calls settles', async () => {
      const mutex = new KeyedMutex();

      let release!: () => void;
      const blocker = new Promise<void>((res) => {
        release = res;
      });

      const p1 = mutex.run('k', async () => {
        await blocker;
      });
      const p2 = mutex.run('k', async () => {
        // noop
      });

      release();
      await Promise.all([p1, p2]);

      await Promise.resolve();
      await Promise.resolve();

      expect(mutex.size).toBe(0);
    });

    it('re-acquisition after GC works correctly', async () => {
      const mutex = new KeyedMutex();

      const r1 = await mutex.run('k', async () => 'first');
      await Promise.resolve();
      await Promise.resolve();
      expect(mutex.size).toBe(0);

      const r2 = await mutex.run('k', async () => 'second');
      expect(r1).toBe('first');
      expect(r2).toBe('second');
    });
  });
});
