/**
 * group-engine.ts — Typed wrapper around the TaskGroup Manifest domain model.
 *
 * Compile-once, memoized at module level (fail-fast on diagnostics).
 * Each public method translates CommandResult → typed result or throws GroupCommandDenied.
 *
 * DSL-vs-wrapper split (see taskgroup.manifest header for the authoritative note):
 * - Manifest guards: status transitions, numeric ranges (createGroup), slot count, booleans
 * - Wrapper logic: children array, requeueStaleChildren loop, cancelGroup child updates,
 *   reportChildFailure branching, settleGroup outcome, duplicate-id check
 *
 * Denial API: GroupCommandDenied error (carries .formatted string from guard expression).
 */

import { compileToIR } from '@angriff36/manifest/ir-compiler';
import { RuntimeEngine } from '@angriff36/manifest';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import type { TaskGroupSnapshot, GroupChildStatus } from '@aboardai/types';

// ─── Manifest type shims ──────────────────────────────────────────────────────

interface IManifestEvent {
  name: string;
  [key: string]: unknown;
}

interface IManifestCommandResult {
  success: boolean;
  /** Scalar return value from the last mutate action (may be undefined for emit-only commands) */
  result?: unknown;
  error?: string;
  emittedEvents: IManifestEvent[];
  guardFailure?: { index: number; expression: string; formatted: string };
}

interface IManifestInstance {
  id: string;
  status?: string;
  runningCount?: number;
  [key: string]: unknown;
}

interface IManifestEngine {
  createInstance(
    entityName: string,
    data: Record<string, unknown>
  ): Promise<IManifestInstance | null>;
  getInstance(entityName: string, id: string): Promise<IManifestInstance | null>;
  runCommand(
    name: string,
    input: Record<string, unknown>,
    ctx: { entityName: string; instanceId: string }
  ): Promise<IManifestCommandResult>;
}

// ─── Compiled IR cache ────────────────────────────────────────────────────────

let _cachedIR: unknown | null = null;

async function getCompiledIR(): Promise<unknown> {
  if (_cachedIR !== null) return _cachedIR;

  // Resolve manifest file relative to this source file
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(thisDir, 'taskgroup.manifest');
  const source = fs.readFileSync(manifestPath, 'utf-8');
  const { ir, diagnostics } = await compileToIR(source);

  const errors = diagnostics.filter(
    (d: { severity: string; message: string; line?: number; column?: number }) =>
      d.severity === 'error'
  );
  if (errors.length > 0) {
    throw new Error(
      `taskgroup.manifest compile errors:\n${errors
        .map(
          (e: { severity: string; message: string; line?: number; column?: number }) =>
            `  [${e.line ?? '?'}:${e.column ?? '?'}] ${e.message}`
        )
        .join('\n')}`
    );
  }
  if (ir === null) {
    throw new Error('taskgroup.manifest: compileToIR returned null IR with no diagnostics');
  }

  _cachedIR = ir;
  return _cachedIR;
}

/** Reset the IR cache — test utility only */
export function _resetIRCache(): void {
  _cachedIR = null;
}

// ─── Error type ───────────────────────────────────────────────────────────────

/** Thrown when a Manifest guard or wrapper validation rejects a command */
export class GroupCommandDenied extends Error {
  readonly formatted: string;
  readonly expression?: string;
  readonly guardIndex?: number;

  constructor(formatted: string, opts?: { expression?: string; guardIndex?: number }) {
    super(formatted);
    this.name = 'GroupCommandDenied';
    this.formatted = formatted;
    this.expression = opts?.expression;
    this.guardIndex = opts?.guardIndex;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function throwIfDenied(
  result: IManifestCommandResult,
  command?: string
): asserts result is IManifestCommandResult & { success: true } {
  if (!result.success) {
    const gf = result.guardFailure;
    if (gf) {
      throw new GroupCommandDenied(gf.formatted, {
        expression: gf.expression,
        guardIndex: gf.index,
      });
    }
    throw new GroupCommandDenied(
      result.error ?? `${command ?? 'Command'} denied (no guard failure detail)`
    );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateGroupInput {
  id: string;
  name: string;
  baseBranch: string | null;
  maxConcurrency: number;
  retryLimit: number;
  childFeatureIds: string[];
}

type ChildRecord = {
  featureId: string;
  status: GroupChildStatus;
  attempts: number;
  lastError?: string;
};

type GroupMeta = {
  name: string;
  baseBranch: string | null;
  maxConcurrency: number;
  retryLimit: number;
  createdAt: string;
};

// ─── GroupEngine ──────────────────────────────────────────────────────────────

/**
 * Typed wrapper around the TaskGroup Manifest entity.
 * One engine instance can host multiple groups. Use `GroupEngine.create()`.
 */
export class GroupEngine {
  private readonly mEngine: IManifestEngine;

  /**
   * Children arrays — keyed by groupId.
   * NOT stored in Manifest (per-element mutation of JSON arrays is not a DSL primitive).
   */
  private readonly _children = new Map<string, ChildRecord[]>();

  /** Group metadata */
  private readonly _meta = new Map<string, GroupMeta>();

  /**
   * Status cache — mirrors Manifest entity status.
   * Updated after every successful command via result.instance.
   */
  private readonly _status = new Map<string, string>();

  private constructor(mEngine: IManifestEngine) {
    this.mEngine = mEngine;
  }

  /** Factory — compiles manifest (IR cached globally), constructs engine. */
  static async create(): Promise<GroupEngine> {
    const ir = await getCompiledIR();
    // RuntimeEngine is typed in @angriff36/manifest but we use our interface shim
    const engine = new (RuntimeEngine as unknown as new (
      ir: unknown,
      ctx: Record<string, unknown>
    ) => IManifestEngine)(ir, {});
    return new GroupEngine(engine);
  }

  // ── cmd ─────────────────────────────────────────────────────────────────────

  private async cmd(
    name: string,
    input: Record<string, unknown>,
    groupId: string
  ): Promise<IManifestCommandResult> {
    const result = await this.mEngine.runCommand(name, input, {
      entityName: 'TaskGroup',
      instanceId: groupId,
    });
    // Sync status cache after successful commands by reading back from MemoryStore
    if (result.success) {
      const inst = await this.mEngine.getInstance('TaskGroup', groupId);
      if (inst?.status !== undefined) {
        this._status.set(groupId, inst.status as string);
      }
    }
    return result;
  }

  // ── createGroup ─────────────────────────────────────────────────────────────

  async createGroup(input: CreateGroupInput): Promise<IManifestEvent[]> {
    const { id, name, baseBranch, maxConcurrency, retryLimit, childFeatureIds } = input;

    // Wrapper: duplicate-id check (uniqueness of an array is inexpressible in DSL)
    const uniqueIds = new Set(childFeatureIds);
    if (uniqueIds.size !== childFeatureIds.length) {
      throw new GroupCommandDenied(
        `createGroup denied: child feature IDs must be unique (${childFeatureIds.length} ids, ${uniqueIds.size} unique)`
      );
    }

    // Create the Manifest entity instance with initial properties
    await this.mEngine.createInstance('TaskGroup', {
      id,
      name,
      baseBranch: baseBranch ?? '',
      maxConcurrency,
      retryLimit,
      status: 'pending',
      runningCount: 0,
    });
    this._status.set(id, 'pending');

    // DSL command runs range guards
    const result = await this.cmd(
      'createGroup',
      { childCount: childFeatureIds.length, maxConcurrency, retryLimit, childIdsUnique: true },
      id
    );
    throwIfDenied(result, 'createGroup');

    // Initialise wrapper state
    this._children.set(
      id,
      childFeatureIds.map((featureId) => ({ featureId, status: 'pending', attempts: 0 }))
    );
    this._meta.set(id, {
      name,
      baseBranch,
      maxConcurrency,
      retryLimit,
      createdAt: new Date().toISOString(),
    });

    return result.emittedEvents;
  }

  // ── startGroup ──────────────────────────────────────────────────────────────

  async startGroup(id: string): Promise<IManifestEvent[]> {
    const result = await this.cmd('startGroup', {}, id);
    throwIfDenied(result, 'startGroup');
    return result.emittedEvents;
  }

  // ── claimSlot ───────────────────────────────────────────────────────────────

  async claimSlot(id: string, featureId: string): Promise<IManifestEvent[]> {
    const children = this._requireChildren(id);
    const child = children.find((c) => c.featureId === featureId);

    // Wrapper computes eligibility boolean for DSL guard
    const childEligible =
      child !== undefined && (child.status === 'pending' || child.status === 'retrying');

    const result = await this.cmd('claimSlot', { childEligible }, id);
    throwIfDenied(result, 'claimSlot');

    // Wrapper: update child status
    if (child) child.status = 'running';

    return result.emittedEvents;
  }

  // ── reportChildSuccess ──────────────────────────────────────────────────────

  async reportChildSuccess(id: string, featureId: string): Promise<IManifestEvent[]> {
    const children = this._requireChildren(id);
    const child = children.find((c) => c.featureId === featureId);

    if (!child || child.status !== 'running') {
      throw new GroupCommandDenied(
        `reportChildSuccess denied: child '${featureId}' in group '${id}' is not running (status: ${child?.status ?? 'not found'})`
      );
    }

    const result = await this.cmd('reportChildSuccess', {}, id);
    throwIfDenied(result, 'reportChildSuccess');

    child.status = 'completed';
    await this._decrementRunningCount(id);

    return result.emittedEvents;
  }

  // ── reportChildFailure ──────────────────────────────────────────────────────

  async reportChildFailure(
    id: string,
    featureId: string,
    error: string
  ): Promise<IManifestEvent[]> {
    const children = this._requireChildren(id);
    const meta = this._requireMeta(id);
    const child = children.find((c) => c.featureId === featureId);

    if (!child || child.status !== 'running') {
      throw new GroupCommandDenied(
        `reportChildFailure denied: child '${featureId}' in group '${id}' is not running (status: ${child?.status ?? 'not found'})`
      );
    }

    // Wrapper: branching (inexpressible in DSL)
    child.attempts += 1;
    const willRetry = child.attempts <= meta.retryLimit;
    const commandName = willRetry ? 'reportChildFailure_retrying' : 'reportChildFailure_failed';

    const result = await this.cmd(commandName, {}, id);
    throwIfDenied(result, commandName);

    if (willRetry) {
      child.status = 'retrying';
    } else {
      child.status = 'failed';
      child.lastError = error;
    }

    await this._decrementRunningCount(id);

    return result.emittedEvents;
  }

  // ── settleGroup ──────────────────────────────────────────────────────────────

  async settleGroup(id: string): Promise<IManifestEvent[]> {
    const children = this._requireChildren(id);

    // Wrapper computes quiescence boolean for DSL guard
    const allChildrenTerminal = children.every(
      (c) => c.status === 'completed' || c.status === 'failed' || c.status === 'skipped'
    );

    const settleResult = await this.cmd('settleGroup', { allChildrenTerminal }, id);
    throwIfDenied(settleResult, 'settleGroup');

    // Wrapper: determine outcome
    const allCompleted = children.every((c) => c.status === 'completed');
    const outcomeCmd = allCompleted ? 'setGroupReview' : 'setGroupFailed';
    const outcomeResult = await this.cmd(outcomeCmd, {}, id);
    throwIfDenied(outcomeResult, outcomeCmd);

    return [...settleResult.emittedEvents, ...outcomeResult.emittedEvents];
  }

  // ── cancelGroup ──────────────────────────────────────────────────────────────

  async cancelGroup(id: string): Promise<IManifestEvent[]> {
    const children = this._requireChildren(id);

    const result = await this.cmd('cancelGroup', {}, id);
    throwIfDenied(result, 'cancelGroup');

    // Wrapper: pending+retrying → skipped; running children left for the queue to report
    for (const child of children) {
      if (child.status === 'pending' || child.status === 'retrying') {
        child.status = 'skipped';
      }
    }

    return result.emittedEvents;
  }

  // ── requeueStaleChildren ─────────────────────────────────────────────────────

  /**
   * Boot recovery: running children → retrying WITHOUT incrementing attempts.
   *
   * DSL guard: status == running.
   * The loop is in the wrapper because per-child conditional bulk mutation with a
   * "no attempts increment" rule is inexpressible in Manifest DSL.
   */
  async requeueStaleChildren(id: string): Promise<IManifestEvent[]> {
    // DSL guard fires first (status == running required)
    const guardResult = await this.cmd('requeueStaleChildren', {}, id);
    throwIfDenied(guardResult, 'requeueStaleChildren');

    const children = this._requireChildren(id);

    // Wrapper loop: running → retrying, NO attempts increment
    for (const child of children) {
      if (child.status === 'running') {
        child.status = 'retrying';
        await this._decrementRunningCount(id);
      }
    }

    return guardResult.emittedEvents;
  }

  // ── getSnapshot ──────────────────────────────────────────────────────────────

  async getSnapshot(id: string): Promise<TaskGroupSnapshot> {
    const children = this._requireChildren(id);
    const meta = this._requireMeta(id);
    const status = this._status.get(id);
    if (status === undefined) {
      throw new Error(`GroupEngine: no status for group '${id}'`);
    }

    return {
      id,
      name: meta.name,
      baseBranch: meta.baseBranch,
      maxConcurrency: meta.maxConcurrency,
      retryLimit: meta.retryLimit,
      status: status as TaskGroupSnapshot['status'],
      children: children.map((c) => ({
        featureId: c.featureId,
        status: c.status,
        attempts: c.attempts,
        ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
      })),
      createdAt: meta.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── rehydrateGroup ────────────────────────────────────────────────────────────

  /**
   * Restore a group from a persisted snapshot into a fresh engine.
   * Uses plain createInstance (MemoryStore has no upsert — fresh boot = empty store).
   * NEVER replays events — snapshot is the source of truth.
   */
  async rehydrateGroup(snapshot: TaskGroupSnapshot): Promise<void> {
    const { id, name, baseBranch, maxConcurrency, retryLimit, status, children, createdAt } =
      snapshot;

    const runningCount = children.filter((c) => c.status === 'running').length;

    await this.mEngine.createInstance('TaskGroup', {
      id,
      name,
      baseBranch: baseBranch ?? '',
      maxConcurrency,
      retryLimit,
      status,
      runningCount,
    });

    this._children.set(
      id,
      children.map((c) => ({
        featureId: c.featureId,
        status: c.status,
        attempts: c.attempts,
        ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
      }))
    );
    this._meta.set(id, { name, baseBranch, maxConcurrency, retryLimit, createdAt });
    this._status.set(id, status);
  }

  // ── private helpers ──────────────────────────────────────────────────────────

  private _requireChildren(id: string): ChildRecord[] {
    const children = this._children.get(id);
    if (!children) throw new Error(`GroupEngine: no children for group '${id}'`);
    return children;
  }

  private _requireMeta(id: string): GroupMeta {
    const meta = this._meta.get(id);
    if (!meta) throw new Error(`GroupEngine: no meta for group '${id}'`);
    return meta;
  }

  private async _decrementRunningCount(id: string): Promise<void> {
    // Best-effort — guard denials are swallowed (running count may already be 0 in edge cases)
    await this.cmd('decrementRunningCount', {}, id);
  }
}
