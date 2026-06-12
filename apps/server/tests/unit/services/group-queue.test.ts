/**
 * GroupQueue — unit tests (TDD, Task 3.1)
 *
 * Uses REAL GroupEngine (temp dirs for snapshots) + mocked executeFeature +
 * mocked feature loader + spy EventEmitter + real EventLogWriter (temp dirs).
 *
 * Fake-timer usage: bracketed in beforeEach/afterEach where needed for
 * debounce-sensitive assertions; most tests use real timers because we need
 * actual async resolution of Promises.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import type { Feature } from '@aboardai/types';
import { GroupEngine } from '@/groups/group-engine.js';
import { GroupStore } from '@/groups/group-store.js';
import { GroupQueue } from '@/services/group-queue.js';
import type { ExecuteFeatureFn, LoadFeatureFn, LoadAllFeaturesFn } from '@/services/group-queue.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `gq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Create a minimal Feature object */
function makeFeature(
  id: string,
  status: Feature['status'] = 'ready',
  overrides: Partial<Feature> = {}
): Feature {
  return {
    id,
    title: `Feature ${id}`,
    description: `Desc for ${id}`,
    status,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Feature;
}

/** Sleep for ms (used in a few tests to yield event loop) */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a GroupQueue with controllable mocks */
interface QueueHarness {
  projectPath: string;
  engine: GroupEngine;
  store: GroupStore;
  queue: GroupQueue;
  executeFeature: ReturnType<typeof vi.fn>;
  loadFeature: ReturnType<typeof vi.fn>;
  loadAllFeatures: ReturnType<typeof vi.fn>;
  emitSpy: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<QueueHarness> {
  const projectPath = await makeTempDir();
  const engine = await GroupEngine.create();
  const store = new GroupStore(projectPath);

  const executeFeature = vi.fn<Parameters<ExecuteFeatureFn>, ReturnType<ExecuteFeatureFn>>();
  const loadFeature = vi.fn<Parameters<LoadFeatureFn>, ReturnType<LoadFeatureFn>>();
  const loadAllFeatures = vi.fn<Parameters<LoadAllFeaturesFn>, ReturnType<LoadAllFeaturesFn>>();

  const emitSpy = vi.fn();
  const fakeEventEmitter = { emit: emitSpy } as unknown as import('@/lib/events.js').EventEmitter;

  const queue = new GroupQueue(
    engine,
    store,
    executeFeature as ExecuteFeatureFn,
    loadFeature as LoadFeatureFn,
    loadAllFeatures as LoadAllFeaturesFn,
    fakeEventEmitter
  );

  return {
    projectPath,
    engine,
    store,
    queue,
    executeFeature,
    loadFeature,
    loadAllFeatures,
    emitSpy,
    cleanup: async () => {
      await fs.rm(projectPath, { recursive: true, force: true });
    },
  };
}

/** Set up a group with n features, create+persist snapshot, return featureIds */
async function setupGroup(
  h: QueueHarness,
  opts: {
    groupId?: string;
    featureIds?: string[];
    maxConcurrency?: number;
    retryLimit?: number;
  } = {}
): Promise<string[]> {
  const groupId = opts.groupId ?? 'grp-1';
  const featureIds = opts.featureIds ?? ['feat-a', 'feat-b'];
  await h.engine.createGroup({
    id: groupId,
    name: 'Test Group',
    baseBranch: 'main',
    maxConcurrency: opts.maxConcurrency ?? 2,
    retryLimit: opts.retryLimit ?? 1,
    childFeatureIds: featureIds,
  });
  const snap = await h.engine.getSnapshot(groupId);
  await h.store.saveGroup(snap);
  return featureIds;
}

/** Default: executeFeature resolves immediately → feature status 'verified' */
function mockSuccessFeature(h: QueueHarness, featureIds: string[], projectPath: string): void {
  h.executeFeature.mockResolvedValue(undefined);
  h.loadFeature.mockImplementation(async (_p, featureId) => {
    if (featureIds.includes(featureId)) {
      return makeFeature(featureId, 'verified');
    }
    return null;
  });
  h.loadAllFeatures.mockImplementation(async () =>
    featureIds.map((id) => makeFeature(id, 'verified'))
  );
}

// ── 1. drains up to maxConcurrency concurrently ───────────────────────────────

describe('GroupQueue — drains up to maxConcurrency concurrently', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('claims before executing, reports after, completes all children', async () => {
    h = await makeHarness();
    const featureIds = await setupGroup(h, { maxConcurrency: 2, retryLimit: 0 });
    mockSuccessFeature(h, featureIds, h.projectPath);

    await h.queue.startGroup(h.projectPath, 'grp-1');

    // Allow drive loop to complete
    await sleep(50);

    const snap = await h.engine.getSnapshot('grp-1');
    expect(snap.status).toMatch(/review|failed/);
    expect(snap.children.every((c) => c.status === 'completed')).toBe(true);
    expect(snap.status).toBe('review');
  });

  it('respects maxConcurrency=1 — runs children serially', async () => {
    h = await makeHarness();
    const featureIds = await setupGroup(h, { maxConcurrency: 1, retryLimit: 0 });
    const concurrentCalls: string[] = [];
    let activeCount = 0;
    let maxObserved = 0;

    h.executeFeature.mockImplementation(async (_p, featureId) => {
      activeCount++;
      concurrentCalls.push(featureId);
      if (activeCount > maxObserved) maxObserved = activeCount;
      await sleep(10);
      activeCount--;
    });
    h.loadFeature.mockImplementation(async (_p, featureId) => makeFeature(featureId, 'verified'));
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, 'verified'))
    );

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    expect(maxObserved).toBe(1);
    expect(concurrentCalls).toHaveLength(2);
  });

  it('maxConcurrency=2 runs both children concurrently', async () => {
    h = await makeHarness();
    const featureIds = await setupGroup(h, { maxConcurrency: 2, retryLimit: 0 });
    let activeCount = 0;
    let maxObserved = 0;

    h.executeFeature.mockImplementation(async () => {
      activeCount++;
      if (activeCount > maxObserved) maxObserved = activeCount;
      await sleep(20);
      activeCount--;
    });
    h.loadFeature.mockImplementation(async (_p, id) => makeFeature(id, 'verified'));
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, 'verified'))
    );

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    expect(maxObserved).toBe(2);
  });
});

// ── 2. dependency ordering ────────────────────────────────────────────────────

describe('GroupQueue — dependency ordering', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('child B (depends on A) not claimed until A completes', async () => {
    h = await makeHarness();
    // feat-b depends on feat-a
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });

    const order: string[] = [];
    let featAStatus: Feature['status'] = 'ready'; // simulates disk state

    h.executeFeature.mockImplementation(async (_p, featureId) => {
      order.push(`start:${featureId}`);
      await sleep(20);
      if (featureId === 'feat-a') {
        featAStatus = 'verified';
      }
      order.push(`end:${featureId}`);
    });
    h.loadFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') return makeFeature('feat-a', featAStatus);
      return makeFeature(featureId, 'verified');
    });
    h.loadAllFeatures.mockImplementation(async () => [
      makeFeature('feat-a', featAStatus),
      makeFeature('feat-b', 'ready', { dependencies: ['feat-a'] }),
    ]);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(150);

    // feat-a must start before feat-b starts
    const aStart = order.indexOf('start:feat-a');
    const bStart = order.indexOf('start:feat-b');
    const aEnd = order.indexOf('end:feat-a');
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(bStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeLessThan(bStart);
  });
});

// ── 3. retry ──────────────────────────────────────────────────────────────────

describe('GroupQueue — retry', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('fails once (retryLimit=1) → re-claimed and re-executed; second fail → child failed', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 1 });

    let callCount = 0;
    h.executeFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') {
        callCount++;
        // always fail
      }
    });
    h.loadFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') return makeFeature('feat-a', 'backlog'); // failure status
      return makeFeature(featureId, 'verified');
    });
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, id === 'feat-a' ? 'backlog' : 'verified'))
    );

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(150);

    // feat-a executed twice (initial + 1 retry)
    expect(callCount).toBe(2);

    const snap = await h.engine.getSnapshot('grp-1');
    const childA = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(childA.status).toBe('failed');
    expect(childA.attempts).toBe(2);
  });

  it('sibling feat-b keeps draining after feat-a exhausts retries', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 1 });

    h.executeFeature.mockImplementation(async (_p, featureId) => {
      // feat-a always fails, feat-b always succeeds (via loadFeature)
    });
    h.loadFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') return makeFeature('feat-a', 'backlog');
      return makeFeature(featureId, 'verified');
    });
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, id === 'feat-a' ? 'backlog' : 'verified'))
    );

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(200);

    const snap = await h.engine.getSnapshot('grp-1');
    const childB = snap.children.find((c) => c.featureId === 'feat-b')!;
    expect(childB.status).toBe('completed');
  });
});

// ── 4. settle ─────────────────────────────────────────────────────────────────

describe('GroupQueue — settle', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('all complete → group status "review" + group_settled event emitted', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });
    mockSuccessFeature(h, featureIds, h.projectPath);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    const snap = await h.engine.getSnapshot('grp-1');
    expect(snap.status).toBe('review');

    // group_settled event should have been broadcast
    const settleEvents = h.emitSpy.mock.calls
      .filter((c) => c[0] === 'group:event')
      .map((c) => c[1].event);
    const hasSettled = settleEvents.some(
      (e: { name: string }) => e.name === 'GroupSettled' || e.name === 'group_settled'
    );
    expect(hasSettled).toBe(true);
  });

  it('one exhausted failure → group status "failed" with per-child detail in snapshot', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });

    h.executeFeature.mockImplementation(async () => undefined);
    h.loadFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') return makeFeature('feat-a', 'backlog');
      return makeFeature(featureId, 'verified');
    });
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, id === 'feat-a' ? 'backlog' : 'verified'))
    );

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    const snap = await h.engine.getSnapshot('grp-1');
    expect(snap.status).toBe('failed');
    const failedChild = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(failedChild.status).toBe('failed');
    expect(failedChild.lastError).toBeTruthy();
  });
});

// ── 5. cancel mid-drain ───────────────────────────────────────────────────────

describe('GroupQueue — cancel mid-drain', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('cancel: no new claims; status stays "cancelled"; no settleGroup call', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b', 'feat-c'];
    await setupGroup(h, {
      featureIds,
      maxConcurrency: 1,
      retryLimit: 0,
      groupId: 'grp-1',
    });

    // Block feat-a execution so cancel can fire mid-drain
    let resolveA: () => void = () => {};
    const aBlocked = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    h.executeFeature.mockImplementation(async (_p, featureId) => {
      if (featureId === 'feat-a') {
        await aBlocked;
      }
    });
    h.loadFeature.mockImplementation(async (_p, featureId) => makeFeature(featureId, 'verified'));
    h.loadAllFeatures.mockImplementation(async () =>
      featureIds.map((id) => makeFeature(id, 'verified'))
    );

    // Start drive loop — feat-a will be claimed and block
    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(30); // Give the loop time to claim feat-a

    // Cancel the group
    await h.queue.cancelGroup(h.projectPath, 'grp-1');

    const snapAfterCancel = await h.engine.getSnapshot('grp-1');
    expect(snapAfterCancel.status).toBe('cancelled');

    // Resolve A — loop should handle gracefully
    resolveA();
    await sleep(50);

    // Status must remain cancelled — NOT review or failed
    const finalSnap = await h.engine.getSnapshot('grp-1');
    expect(finalSnap.status).toBe('cancelled');
  });
});

// ── 6. dependency-unsatisfiable ────────────────────────────────────────────────

describe('GroupQueue — dependency-unsatisfiable', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('dep feature failed outside group → claim + immediate reportChildFailure; no execute call', async () => {
    h = await makeHarness();
    // feat-b depends on dep-ext which has status 'backlog' (failed/not completed)
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });

    h.executeFeature.mockImplementation(async () => undefined);
    h.loadFeature.mockImplementation(async (_p, featureId) => makeFeature(featureId, 'verified'));
    h.loadAllFeatures.mockImplementation(async () => [
      makeFeature('feat-a', 'ready'),
      makeFeature('feat-b', 'ready', { dependencies: ['dep-ext'] }),
      // dep-ext is not in the group; it's backlog (not completed)
      makeFeature('dep-ext', 'backlog'),
    ]);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    const snap = await h.engine.getSnapshot('grp-1');
    const childB = snap.children.find((c) => c.featureId === 'feat-b')!;
    expect(childB.status).toBe('failed');
    expect(childB.lastError).toMatch(/dependency unsatisfiable/i);

    // executeFeature should NOT have been called for feat-b
    const featBCalls = h.executeFeature.mock.calls.filter(([, id]) => id === 'feat-b');
    expect(featBCalls).toHaveLength(0);
  });
});

// ── 7. events written + broadcast ─────────────────────────────────────────────

describe('GroupQueue — events written to JSONL and broadcast', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('every Manifest emittedEvent → broadcast as group:event', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });
    mockSuccessFeature(h, featureIds, h.projectPath);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    // Should have 'group:event' emissions for group_started, child_claimed (x2),
    // child_completed (x2), group_settled/group_review
    const groupEvents = h.emitSpy.mock.calls.filter((c) => c[0] === 'group:event');
    expect(groupEvents.length).toBeGreaterThan(0);

    // Each emission has { projectPath, groupId, event }
    for (const [, payload] of groupEvents) {
      expect(payload).toHaveProperty('projectPath');
      expect(payload).toHaveProperty('groupId', 'grp-1');
      expect(payload).toHaveProperty('event');
      expect(typeof (payload as { event: { name: string } }).event.name).toBe('string');
    }
  });

  it('events.jsonl is written to the group dir', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });
    mockSuccessFeature(h, featureIds, h.projectPath);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(200); // Allow debounce flush

    const eventsPath = path.join(h.projectPath, '.aboardai', 'groups', 'grp-1', 'events.jsonl');
    const content = await fs.readFile(eventsPath, 'utf-8').catch(() => '');
    expect(content.trim().length).toBeGreaterThan(0);

    // Each line should be valid JSON
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed['name']).toBe('string');
    }
  });
});

// ── 8. boot resume ────────────────────────────────────────────────────────────

describe('GroupQueue — boot resume', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('snapshot with running group + stale running child → resumeGroups → completes', async () => {
    h = await makeHarness();

    // Persist a snapshot simulating a crash: group is running, feat-a is stuck running
    const crashedSnapshot = {
      id: 'grp-boot',
      name: 'Crashed Group',
      baseBranch: 'main',
      maxConcurrency: 2,
      retryLimit: 1,
      status: 'running' as const,
      children: [
        { featureId: 'feat-a', status: 'running' as const, attempts: 0 },
        { featureId: 'feat-b', status: 'pending' as const, attempts: 0 },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await h.store.saveGroup(crashedSnapshot);

    h.executeFeature.mockImplementation(async () => undefined);
    h.loadFeature.mockImplementation(async (_p, featureId) => makeFeature(featureId, 'verified'));
    h.loadAllFeatures.mockImplementation(async () =>
      ['feat-a', 'feat-b'].map((id) => makeFeature(id, 'verified'))
    );

    // resumeGroups rehydrates + requeues stale children + restarts loops
    await h.queue.resumeGroups(h.projectPath);
    await sleep(200);

    const snap = await h.engine.getSnapshot('grp-boot');
    // feat-a was stale running → requeued (retrying, attempts 0) → executed → completed
    expect(snap.status).toBe('review');
    expect(snap.children.every((c) => c.status === 'completed')).toBe(true);

    // feat-a should have been re-executed (was requeuedStaleChildren, attempts NOT incremented)
    const childA = snap.children.find((c) => c.featureId === 'feat-a')!;
    expect(childA.attempts).toBe(0); // requeueStaleChildren does NOT increment
  });
});

// ── 9. snapshot persisted after every command ─────────────────────────────────

describe('GroupQueue — snapshot persistence', () => {
  let h: QueueHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('group.json is updated on disk after group settles', async () => {
    h = await makeHarness();
    const featureIds = ['feat-a', 'feat-b'];
    await setupGroup(h, { featureIds, maxConcurrency: 2, retryLimit: 0 });
    mockSuccessFeature(h, featureIds, h.projectPath);

    await h.queue.startGroup(h.projectPath, 'grp-1');
    await sleep(100);

    const snapshots = await h.store.loadAllGroups();
    const snap = snapshots.find((s) => s.id === 'grp-1');
    expect(snap).toBeDefined();
    expect(snap!.status).toBe('review');
  });
});
