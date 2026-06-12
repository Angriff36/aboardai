/**
 * Behavior tests for the TaskGroup domain engine (group-engine.ts + group-store.ts).
 *
 * Written TDD-style — these tests define the contract BEFORE implementation.
 * One test per command-table row + every guard-denial case + persistence round-trip
 * + boot recovery.
 *
 * Guard-denial API: GroupCommandDenied error (typed, carries .formatted string).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

import { GroupEngine, GroupCommandDenied } from '@/groups/group-engine';
import { GroupStore } from '@/groups/group-store';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimum valid createGroup input */
const BASE_CREATE = {
  id: 'grp-1',
  name: 'My Group',
  baseBranch: 'main',
  maxConcurrency: 2,
  retryLimit: 1,
  childFeatureIds: ['feat-a', 'feat-b'],
};

async function makeEngine(): Promise<GroupEngine> {
  return GroupEngine.create();
}

// ─── 1. createGroup ───────────────────────────────────────────────────────────

describe('createGroup', () => {
  it('creates a group with all children pending', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('pending');
    expect(snap.children).toHaveLength(2);
    expect(snap.children.every((c) => c.status === 'pending')).toBe(true);
    expect(snap.children.every((c) => c.attempts === 0)).toBe(true);
  });

  it('emits GroupCreated event', async () => {
    const engine = await makeEngine();
    const events = await engine.createGroup(BASE_CREATE);
    expect(events.some((e) => e.name === 'GroupCreated')).toBe(true);
  });

  it('DENIED: fewer than 2 children', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', childFeatureIds: ['only-one'] })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: more than 20 children', async () => {
    const engine = await makeEngine();
    const ids = Array.from({ length: 21 }, (_, i) => `feat-${i}`);
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', childFeatureIds: ids })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: duplicate child ids', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', childFeatureIds: ['feat-a', 'feat-a'] })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: maxConcurrency 0', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', maxConcurrency: 0 })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: maxConcurrency 11', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', maxConcurrency: 11 })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: retryLimit 6', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({ ...BASE_CREATE, id: 'grp-x', retryLimit: 6 })
    ).rejects.toThrow(GroupCommandDenied);
  });

  it('ALLOWED: boundary values (2 children, maxConcurrency 1, retryLimit 0)', async () => {
    const engine = await makeEngine();
    await expect(
      engine.createGroup({
        ...BASE_CREATE,
        id: 'grp-x',
        childFeatureIds: ['feat-a', 'feat-b'],
        maxConcurrency: 1,
        retryLimit: 0,
      })
    ).resolves.not.toThrow();
  });

  it('ALLOWED: boundary values (20 children, maxConcurrency 10, retryLimit 5)', async () => {
    const engine = await makeEngine();
    const ids = Array.from({ length: 20 }, (_, i) => `feat-${i}`);
    await expect(
      engine.createGroup({
        ...BASE_CREATE,
        id: 'grp-x',
        childFeatureIds: ids,
        maxConcurrency: 10,
        retryLimit: 5,
      })
    ).resolves.not.toThrow();
  });

  it('GroupCommandDenied carries formatted message', async () => {
    const engine = await makeEngine();
    try {
      await engine.createGroup({ ...BASE_CREATE, id: 'grp-x', childFeatureIds: ['one'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GroupCommandDenied);
      const denial = err as GroupCommandDenied;
      expect(typeof denial.formatted).toBe('string');
      expect(denial.formatted.length).toBeGreaterThan(0);
    }
  });
});

// ─── 2. startGroup ────────────────────────────────────────────────────────────

describe('startGroup', () => {
  it('transitions pending → running', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    await engine.startGroup('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('running');
  });

  it('emits GroupStarted event', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    const events = await engine.startGroup('grp-1');
    expect(events.some((e) => e.name === 'GroupStarted')).toBe(true);
  });

  it('DENIED: startGroup on already-running group', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    await engine.startGroup('grp-1');
    await expect(engine.startGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 3. claimSlot ─────────────────────────────────────────────────────────────

describe('claimSlot', () => {
  async function startedEngine(): Promise<GroupEngine> {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 1 });
    await engine.startGroup('grp-1');
    return engine;
  }

  it('transitions pending child → running', async () => {
    const engine = await startedEngine();
    await engine.claimSlot('grp-1', 'feat-a');
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('running');
  });

  it('emits ChildClaimed event', async () => {
    const engine = await startedEngine();
    const events = await engine.claimSlot('grp-1', 'feat-a');
    expect(events.some((e) => e.name === 'ChildClaimed')).toBe(true);
  });

  it('DENIED: claimSlot at capacity (maxConcurrency 1, one already running)', async () => {
    const engine = await startedEngine();
    await engine.claimSlot('grp-1', 'feat-a'); // fills the slot
    await expect(engine.claimSlot('grp-1', 'feat-b')).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: claimSlot on completed child', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.reportChildSuccess('grp-1', 'feat-a');
    await expect(engine.claimSlot('grp-1', 'feat-a')).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: claimSlot on non-running group (still pending)', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    // NOT started
    await expect(engine.claimSlot('grp-1', 'feat-a')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 4. reportChildSuccess ────────────────────────────────────────────────────

describe('reportChildSuccess', () => {
  async function withRunningChild(): Promise<GroupEngine> {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    return engine;
  }

  it('transitions running child → completed', async () => {
    const engine = await withRunningChild();
    await engine.reportChildSuccess('grp-1', 'feat-a');
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('completed');
  });

  it('emits ChildCompleted event', async () => {
    const engine = await withRunningChild();
    const events = await engine.reportChildSuccess('grp-1', 'feat-a');
    expect(events.some((e) => e.name === 'ChildCompleted')).toBe(true);
  });

  it('DENIED: reportChildSuccess on non-running (pending) child', async () => {
    const engine = await withRunningChild();
    // feat-b is still pending
    await expect(engine.reportChildSuccess('grp-1', 'feat-b')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 5. reportChildFailure ────────────────────────────────────────────────────

describe('reportChildFailure', () => {
  async function withRunningChild(retryLimit = 1): Promise<GroupEngine> {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2, retryLimit });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    return engine;
  }

  it('increments attempts and sets child → retrying when attempts ≤ retryLimit', async () => {
    const engine = await withRunningChild(1);
    await engine.reportChildFailure('grp-1', 'feat-a', 'first failure');
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('retrying');
    expect(child.attempts).toBe(1);
  });

  it('emits ChildRetrying when attempts ≤ retryLimit', async () => {
    const engine = await withRunningChild(1);
    const events = await engine.reportChildFailure('grp-1', 'feat-a', 'first failure');
    expect(events.some((e) => e.name === 'ChildRetrying')).toBe(true);
  });

  it('sets child → failed (with lastError) when attempts exceed retryLimit', async () => {
    const engine = await withRunningChild(0); // retryLimit 0 means fail immediately
    const events = await engine.reportChildFailure('grp-1', 'feat-a', 'fatal error');
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('failed');
    expect(child.attempts).toBe(1);
    expect(child.lastError).toBe('fatal error');
    expect(events.some((e) => e.name === 'ChildFailed')).toBe(true);
  });

  it('retrying child gets re-claimed and then fails on second attempt (retryLimit=1)', async () => {
    const engine = await withRunningChild(1);
    await engine.reportChildFailure('grp-1', 'feat-a', 'first failure');
    // re-claim (retrying → running)
    await engine.claimSlot('grp-1', 'feat-a');
    // fail again — attempts=2 > retryLimit=1 → failed
    await engine.reportChildFailure('grp-1', 'feat-a', 'second failure');
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('failed');
    expect(child.attempts).toBe(2);
    expect(child.lastError).toBe('second failure');
  });

  it('DENIED: reportChildFailure on non-running (pending) child', async () => {
    const engine = await withRunningChild(1);
    // feat-b is still pending
    await expect(engine.reportChildFailure('grp-1', 'feat-b', 'err')).rejects.toThrow(
      GroupCommandDenied
    );
  });
});

// ─── 6. settleGroup ───────────────────────────────────────────────────────────

describe('settleGroup', () => {
  it('settles → review when all children completed', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.claimSlot('grp-1', 'feat-b');
    await engine.reportChildSuccess('grp-1', 'feat-a');
    await engine.reportChildSuccess('grp-1', 'feat-b');
    const events = await engine.settleGroup('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('review');
    expect(events.some((e) => e.name === 'GroupSettled')).toBe(true);
  });

  it('settles → failed when ≥1 child failed', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2, retryLimit: 0 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.claimSlot('grp-1', 'feat-b');
    await engine.reportChildSuccess('grp-1', 'feat-a');
    await engine.reportChildFailure('grp-1', 'feat-b', 'fatal');
    const events = await engine.settleGroup('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('failed');
    expect(events.some((e) => e.name === 'GroupSettled')).toBe(true);
  });

  it('DENIED: settleGroup while a child is still retrying', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2, retryLimit: 1 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.claimSlot('grp-1', 'feat-b');
    await engine.reportChildSuccess('grp-1', 'feat-b');
    await engine.reportChildFailure('grp-1', 'feat-a', 'err'); // → retrying
    await expect(engine.settleGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: settleGroup while a child is still pending', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 1 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.reportChildSuccess('grp-1', 'feat-a');
    // feat-b is still pending
    await expect(engine.settleGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: settleGroup while a child is still running', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.claimSlot('grp-1', 'feat-b');
    await engine.reportChildSuccess('grp-1', 'feat-b');
    // feat-a is still running
    await expect(engine.settleGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 7. cancelGroup ───────────────────────────────────────────────────────────

describe('cancelGroup', () => {
  it('cancels a pending group, marks pending children skipped', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    const events = await engine.cancelGroup('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('cancelled');
    expect(snap.children.every((c) => c.status === 'skipped')).toBe(true);
    expect(events.some((e) => e.name === 'GroupCancelled')).toBe(true);
  });

  it('cancels a running group: pending+retrying → skipped, running children untouched', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 1, retryLimit: 1 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a'); // feat-a running
    await engine.cancelGroup('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    expect(snap.status).toBe('cancelled');
    // running child left as-is
    const runningChild = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(runningChild.status).toBe('running');
    // pending child → skipped
    const pendingChild = snap.children.find((c) => c.featureId === 'feat-b')!;
    expect(pendingChild.status).toBe('skipped');
  });

  it('DENIED: cancelGroup on settled (review) group', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.claimSlot('grp-1', 'feat-b');
    await engine.reportChildSuccess('grp-1', 'feat-a');
    await engine.reportChildSuccess('grp-1', 'feat-b');
    await engine.settleGroup('grp-1');
    await expect(engine.cancelGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });

  it('DENIED: cancelGroup on already-cancelled group', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    await engine.cancelGroup('grp-1');
    await expect(engine.cancelGroup('grp-1')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 8. requeueStaleChildren ──────────────────────────────────────────────────

describe('requeueStaleChildren', () => {
  it('transitions running children → retrying WITHOUT incrementing attempts', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a'); // feat-a running, attempts 0
    await engine.claimSlot('grp-1', 'feat-b'); // feat-b running, attempts 0
    await engine.requeueStaleChildren('grp-1');
    const snap = await engine.getSnapshot('grp-1');
    const childA = snap.children.find((c) => c.featureId === 'feat-a')!;
    const childB = snap.children.find((c) => c.featureId === 'feat-b')!;
    expect(childA.status).toBe('retrying');
    expect(childB.status).toBe('retrying');
    // KEY: attempts must NOT have been incremented by requeue
    expect(childA.attempts).toBe(0);
    expect(childB.attempts).toBe(0);
  });

  it('after requeue, children are claimable again', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await engine.requeueStaleChildren('grp-1');
    // Should be able to claim again without denial
    await expect(engine.claimSlot('grp-1', 'feat-a')).resolves.not.toThrow();
    const snap = await engine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('running');
  });

  it('emits child_requeued events', async () => {
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    const events = await engine.requeueStaleChildren('grp-1');
    expect(events.some((e) => e.name === 'StaleChildrenRequeued')).toBe(true);
  });

  it('no-op when no running children exist', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    await engine.startGroup('grp-1');
    // no claimSlot — all pending
    const events = await engine.requeueStaleChildren('grp-1');
    // StaleChildrenRequeued is emitted but requeuedCount=0 — no per-child events expected
    expect(events.filter((e) => e.name === 'ChildRequeued')).toHaveLength(0);
  });

  it('DENIED: requeueStaleChildren on non-running (pending) group', async () => {
    const engine = await makeEngine();
    await engine.createGroup(BASE_CREATE);
    // NOT started
    await expect(engine.requeueStaleChildren('grp-1')).rejects.toThrow(GroupCommandDenied);
  });
});

// ─── 9. Snapshot round-trip + boot rehydration ───────────────────────────────

describe('snapshot round-trip and boot rehydration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aboardai-group-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists snapshot after each command, reload returns identical state', async () => {
    const store = new GroupStore(tmpDir);
    const engine = await makeEngine();

    await engine.createGroup(BASE_CREATE);
    await store.saveGroup(await engine.getSnapshot('grp-1'));

    await engine.startGroup('grp-1');
    await store.saveGroup(await engine.getSnapshot('grp-1'));

    await engine.claimSlot('grp-1', 'feat-a');
    await store.saveGroup(await engine.getSnapshot('grp-1'));

    await engine.reportChildSuccess('grp-1', 'feat-a');
    await store.saveGroup(await engine.getSnapshot('grp-1'));

    const originalSnap = await engine.getSnapshot('grp-1');

    // ── reload into a fresh engine ──
    const freshEngine = await makeEngine();
    const allSnapshots = await store.loadAllGroups();
    for (const snap of allSnapshots) {
      await freshEngine.rehydrateGroup(snap);
    }

    const reloadedSnap = await freshEngine.getSnapshot('grp-1');
    expect(reloadedSnap.status).toBe(originalSnap.status);
    expect(reloadedSnap.children).toEqual(originalSnap.children);
    expect(reloadedSnap.maxConcurrency).toBe(originalSnap.maxConcurrency);
    expect(reloadedSnap.retryLimit).toBe(originalSnap.retryLimit);
  });

  it('boot recovery: snapshot with running child → requeueStaleChildren → claimable, attempts unchanged', async () => {
    const store = new GroupStore(tmpDir);

    // Build a state: group running, feat-a running (simulates crash mid-execution)
    const engine = await makeEngine();
    await engine.createGroup({ ...BASE_CREATE, maxConcurrency: 2 });
    await engine.startGroup('grp-1');
    await engine.claimSlot('grp-1', 'feat-a');
    await store.saveGroup(await engine.getSnapshot('grp-1'));

    // Verify feat-a is running in the snapshot
    const savedSnap = (await store.loadAllGroups()).find((s) => s.id === 'grp-1')!;
    const savedChild = savedSnap.children.find((c) => c.featureId === 'feat-a')!;
    expect(savedChild.status).toBe('running');

    // ── boot recovery ──
    const bootEngine = await makeEngine();
    await bootEngine.rehydrateGroup(savedSnap);
    await bootEngine.requeueStaleChildren('grp-1');

    const snap = await bootEngine.getSnapshot('grp-1');
    const child = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(child.status).toBe('retrying');
    expect(child.attempts).toBe(0); // NOT incremented by requeue

    // And now claimable again
    await expect(bootEngine.claimSlot('grp-1', 'feat-a')).resolves.not.toThrow();
  });
});
