import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLeaseManager } from '@/services/workspace-lease-manager.js';

describe('WorkspaceLeaseManager', () => {
  it('serializes slash and case variants of the same Windows checkout', async () => {
    const leases = new WorkspaceLeaseManager();
    const releaseFirst = await leases.acquire('C:\\Repo\\Feature', 'feature-one');
    let secondAcquired = false;
    const second = leases.acquire('c:/repo/feature/', 'feature-two').then((release) => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('allows distinct checkout paths to acquire concurrently', async () => {
    const leases = new WorkspaceLeaseManager();
    const [releaseFirst, releaseSecond] = await Promise.all([
      leases.acquire('C:/repo/one', 'feature-one'),
      leases.acquire('C:/repo/two', 'feature-two'),
    ]);

    releaseFirst();
    releaseSecond();
  });

  it('wakes waiters in FIFO order', async () => {
    const leases = new WorkspaceLeaseManager();
    const order: string[] = [];
    const releaseFirst = await leases.acquire('/repo/shared', 'feature-one');
    const second = leases.acquire('/repo/shared', 'feature-two').then((release) => {
      order.push('second');
      return release;
    });
    const third = leases.acquire('/repo/shared', 'feature-three').then((release) => {
      order.push('third');
      return release;
    });

    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(['second', 'third']);
    releaseThird();
  });

  it('removes an aborted waiter without blocking the queue', async () => {
    const leases = new WorkspaceLeaseManager();
    const releaseFirst = await leases.acquire('/repo/shared', 'feature-one');
    const controller = new AbortController();
    const aborted = leases.acquire('/repo/shared', 'feature-two', controller.signal);
    const acquired = vi.fn();
    const third = leases.acquire('/repo/shared', 'feature-three').then((release) => {
      acquired();
      return release;
    });

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst();
    const releaseThird = await third;
    expect(acquired).toHaveBeenCalledOnce();
    releaseThird();
  });

  it('supports reentrant acquisition by the same feature', async () => {
    const leases = new WorkspaceLeaseManager();
    const releaseOuter = await leases.acquire('/repo/shared', 'feature-one');
    const releaseInner = await leases.acquire('/repo/shared', 'feature-one');
    let nextAcquired = false;
    const next = leases.acquire('/repo/shared', 'feature-two').then((release) => {
      nextAcquired = true;
      return release;
    });

    releaseInner();
    await Promise.resolve();
    expect(nextAcquired).toBe(false);
    releaseOuter();
    const releaseNext = await next;
    expect(nextAcquired).toBe(true);
    releaseNext();
  });
});
