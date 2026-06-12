/**
 * GroupQueue — drives TaskGroup children through auto-mode execution.
 *
 * One drive loop per group (async, abortable via AbortController).
 * Slot accounting is purely via Manifest guards: claimSlot denial = backpressure.
 *
 * Dependency satisfaction: a child can run when all its feature deps are in
 * SUCCESS_STATUSES (verified|waiting_approval|completed).  This is intentionally
 * broader than areDependenciesSatisfied (completed|verified only) so that a dep
 * that finished as waiting_approval still unblocks its dependents.
 * A child whose deps can NEVER be satisfied (a dep feature is failed/lost) is
 * claimed and immediately reportedFailure — no executeFeature call.
 *
 * executeFeature success/failure rule:
 *   Success = resolved without throwing AND reloaded feature status ∈
 *             { 'verified', 'waiting_approval', 'completed' }
 *   Failure = anything else after resolve (backlog, interrupted, merge_conflict…)
 *             OR executeFeature threw (shouldn't happen — it swallows errors — but
 *             we catch defensively anyway).
 *
 * Events: after every successful engine command, emittedEvents are written to
 * {projectPath}/.aboardai/groups/{groupId}/events.jsonl via EventLogWriter{dir}
 * AND broadcast as 'group:event'.
 *
 * Boot hook: call resumeGroups(projectPath) where recovery-service runs at startup.
 *
 * Windows note: atomicWriteJson uses rename which races on Windows when concurrent
 * writes target the same file. All store.saveGroup calls per group are serialized
 * via _persistChains (promise chain per group key).
 */

import path from 'path';
import type { Feature } from '@aboardai/types';
import { createLogger } from '@aboardai/utils';
import type { GroupEngine } from '../groups/group-engine.js';
import type { GroupStore } from '../groups/group-store.js';
import { EventLogWriter } from '../events/event-log.js';
import type { EventEmitter } from '../lib/events.js';

const logger = createLogger('GroupQueue');

// ── Terminal feature statuses that count as success ──────────────────────────

const SUCCESS_STATUSES = new Set(['verified', 'waiting_approval', 'completed']);

/** True if the feature landed in a successful terminal state */
function isFeatureSuccess(feature: Feature | null): boolean {
  return feature !== null && SUCCESS_STATUSES.has(feature.status ?? '');
}

// ── Types injected into GroupQueue ────────────────────────────────────────────

/**
 * Signature of autoModeService.executeFeature (the projectPath-forwarding variant
 * exposed by AutoModeServiceCompat and used throughout the codebase).
 *
 * Returns Promise<void> — never rejects to caller; errors update feature.status.
 */
export type ExecuteFeatureFn = (
  projectPath: string,
  featureId: string,
  useWorktrees: boolean,
  isAutoMode: boolean
) => Promise<void>;

/**
 * Load a single feature by id from disk. Returns null when not found.
 */
export type LoadFeatureFn = (projectPath: string, featureId: string) => Promise<Feature | null>;

/**
 * Load all features for a project.
 */
export type LoadAllFeaturesFn = (projectPath: string) => Promise<Feature[]>;

/** Manifest event emitted by CommandResult.emittedEvents */
interface ManifestEvent {
  name: string;
  [key: string]: unknown;
}

// ── GroupQueue ─────────────────────────────────────────────────────────────────

export class GroupQueue {
  /** AbortControllers for running drive loops, keyed by `${projectPath}::${groupId}` */
  private readonly _loops = new Map<string, AbortController>();

  /**
   * Per-group serialized persist chains — Windows atomicWriteJson (rename) races
   * when multiple concurrent writes target the same file. We serialize all
   * store.saveGroup calls per group via promise chaining.
   */
  private readonly _persistChains = new Map<string, Promise<void>>();

  constructor(
    private readonly engine: GroupEngine,
    private readonly store: GroupStore,
    private readonly executeFeature: ExecuteFeatureFn,
    private readonly loadFeature: LoadFeatureFn,
    private readonly loadAllFeatures: LoadAllFeaturesFn,
    private readonly events: EventEmitter
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────────

  private loopKey(projectPath: string, groupId: string): string {
    return `${projectPath}::${groupId}`;
  }

  private groupEventsDir(projectPath: string, groupId: string): string {
    return path.join(projectPath, '.aboardai', 'groups', groupId);
  }

  /**
   * Serialize a saveGroup call per groupId to prevent Windows EPERM races.
   * atomicWriteJson uses rename which fails on Windows when two renames race
   * onto the same target file. Reads the latest snapshot from engine inside
   * the chain so it always persists the most recent state.
   */
  private saveGroupSerialized(projectPath: string, groupId: string): Promise<void> {
    const key = this.loopKey(projectPath, groupId);
    const prev = this._persistChains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const snap = await this.engine.getSnapshot(groupId);
      await this.store.saveGroup(snap);
    });
    // Store a version that won't reject so future .then() chaining works
    this._persistChains.set(
      key,
      next.catch(() => {})
    );
    return next;
  }

  /**
   * Write Manifest events to the group events.jsonl and broadcast 'group:event'.
   */
  private emitGroupEvents(
    projectPath: string,
    groupId: string,
    manifestEvents: ManifestEvent[],
    writer: EventLogWriter
  ): void {
    for (const evt of manifestEvents) {
      writer.appendRaw(evt as Record<string, unknown>);
      this.events.emit('group:event', { projectPath, groupId, event: evt });
    }
  }

  // ── startGroup ───────────────────────────────────────────────────────────────

  /**
   * Run engine.startGroup, persist the snapshot, then spawn the drive loop.
   */
  async startGroup(projectPath: string, groupId: string): Promise<void> {
    const emittedEvents = await this.engine.startGroup(groupId);
    await this.saveGroupSerialized(projectPath, groupId);

    const writer = new EventLogWriter({ dir: this.groupEventsDir(projectPath, groupId) });
    this.emitGroupEvents(projectPath, groupId, emittedEvents, writer);

    this._spawnDriveLoop(projectPath, groupId, writer);
  }

  // ── cancelGroup ──────────────────────────────────────────────────────────────

  /**
   * Cancel the group: engine command → persist → abort the drive loop.
   * In-flight children will resolve and their reports will be accepted by the engine
   * (running→completed/failed), then ignored for scheduling.
   */
  async cancelGroup(projectPath: string, groupId: string): Promise<void> {
    const emittedEvents = await this.engine.cancelGroup(groupId);
    await this.saveGroupSerialized(projectPath, groupId);

    const writer = new EventLogWriter({ dir: this.groupEventsDir(projectPath, groupId) });
    this.emitGroupEvents(projectPath, groupId, emittedEvents, writer);

    const key = this.loopKey(projectPath, groupId);
    this._loops.get(key)?.abort();
    this._loops.delete(key);
  }

  // ── resumeGroups (boot recovery) ─────────────────────────────────────────────

  /**
   * Load all persisted groups; for running groups, requeue stale children and
   * restart drive loops. Call this once at boot after the engine is hydrated.
   *
   * Typical boot sequence (caller's responsibility, shown for reference):
   *   const snapshots = await store.loadAllGroups();
   *   for (const snap of snapshots) await engine.rehydrateGroup(snap);
   *   await groupQueue.resumeGroups(projectPath);
   */
  async resumeGroups(projectPath: string): Promise<void> {
    const snapshots = await this.store.loadAllGroups();

    for (const snap of snapshots) {
      if (snap.status !== 'running') continue;

      // Rehydrate into the engine (safe to call even if already done by caller)
      try {
        await this.engine.rehydrateGroup(snap);
      } catch {
        // Already rehydrated or other error — proceed anyway
      }

      // Requeue any stale 'running' children (crashed mid-execution)
      try {
        const requeueEvents = await this.engine.requeueStaleChildren(snap.id);
        await this.saveGroupSerialized(projectPath, snap.id);

        const writer = new EventLogWriter({ dir: this.groupEventsDir(projectPath, snap.id) });
        this.emitGroupEvents(projectPath, snap.id, requeueEvents, writer);

        this._spawnDriveLoop(projectPath, snap.id, writer);
      } catch (err) {
        logger.warn(`[resumeGroups] Failed to resume group ${snap.id}:`, err);
      }
    }
  }

  // ── drive loop ────────────────────────────────────────────────────────────────

  private _spawnDriveLoop(projectPath: string, groupId: string, writer: EventLogWriter): void {
    const key = this.loopKey(projectPath, groupId);

    // Abort any existing loop for this group
    this._loops.get(key)?.abort();

    const abort = new AbortController();
    this._loops.set(key, abort);

    // Fire-and-forget; errors are caught inside
    void this._driveLoop(projectPath, groupId, writer, abort.signal).finally(() => {
      // Clean up if this is still the registered controller
      if (this._loops.get(key) === abort) {
        this._loops.delete(key);
      }
    });
  }

  private async _driveLoop(
    projectPath: string,
    groupId: string,
    writer: EventLogWriter,
    signal: AbortSignal
  ): Promise<void> {
    /**
     * Drive loop: repeatedly attempt to claim free slots and execute children
     * until quiescence (no more claimable children and none running).
     *
     * Backpressure: claimSlot denial means no free slot → wait for the next
     * report to free a slot rather than busy-spinning.
     *
     * We track in-flight promises and use a simple "wait for the next completion"
     * pattern: after trying all claimable children and finding none (or capacity
     * full), await the next in-flight completion before trying again.
     */

    const inFlight = new Map<string, Promise<void>>();

    /** Try to claim and execute one eligible child. Returns true if claimed. */
    const tryClaimOne = async (): Promise<boolean> => {
      if (signal.aborted) return false;

      const snapshot = await this.engine.getSnapshot(groupId);
      if (snapshot.status === 'cancelled') return false;

      // Load current feature states for dependency resolution
      const allFeatures = await this.loadAllFeatures(projectPath);

      // Collect claimable children (pending|retrying, not already in-flight)
      const claimable = snapshot.children.filter(
        (c) => (c.status === 'pending' || c.status === 'retrying') && !inFlight.has(c.featureId)
      );

      for (const child of claimable) {
        if (signal.aborted) return false;

        const childFeature = allFeatures.find((f) => f.id === child.featureId) ?? null;

        // Check dependency satisfiability
        if (childFeature && childFeature.dependencies && childFeature.dependencies.length > 0) {
          // Check if any dep is in a terminal-failed state (unsatisfiable)
          const isUnsatisfiable = childFeature.dependencies.some((depId) => {
            const dep = allFeatures.find((f) => f.id === depId);
            // A dep is unsatisfiable if it's missing entirely
            if (!dep) return true;
            // If dep is a sibling in this group, check if it permanently failed/skipped
            const depChild = snapshot.children.find((c) => c.featureId === depId);
            if (depChild) {
              return depChild.status === 'failed' || depChild.status === 'skipped';
            }
            // Dep is outside the group — unsatisfiable if not in a success state
            return !SUCCESS_STATUSES.has(dep.status ?? '');
          });

          if (isUnsatisfiable) {
            // Claim then immediately report failure — no execute call
            try {
              const claimEvents = await this.engine.claimSlot(groupId, child.featureId);
              await this.saveGroupSerialized(projectPath, groupId);
              this.emitGroupEvents(projectPath, groupId, claimEvents, writer);

              const failEvents = await this.engine.reportChildFailure(
                groupId,
                child.featureId,
                'dependency unsatisfiable'
              );
              await this.saveGroupSerialized(projectPath, groupId);
              this.emitGroupEvents(projectPath, groupId, failEvents, writer);
            } catch (err) {
              logger.warn(
                `[driveLoop] Failed to process unsatisfiable child ${child.featureId}:`,
                err
              );
            }
            continue;
          }

          // Deps present — check if currently satisfied.
          // Use SUCCESS_STATUSES (verified|waiting_approval|completed) as the
          // "dep done" criterion — this matches the same set used by isFeatureSuccess
          // so a dep that completed via mock-agent (waiting_approval) unblocks its
          // dependents correctly.  areDependenciesSatisfied only accepts
          // completed|verified, which excludes waiting_approval and would leave
          // dependents stuck forever.
          const depsSatisfied = (childFeature.dependencies ?? []).every((depId) => {
            const dep = allFeatures.find((f) => f.id === depId);
            return dep != null && SUCCESS_STATUSES.has(dep.status ?? '');
          });
          if (!depsSatisfied) {
            continue; // Blocked, skip for now
          }
        }

        // Try to claim a slot
        let claimEvents: ManifestEvent[];
        try {
          claimEvents = await this.engine.claimSlot(groupId, child.featureId);
        } catch {
          // claimSlot denied = no free slot (or wrong status) → stop trying for this pass
          break;
        }

        await this.saveGroupSerialized(projectPath, groupId);
        this.emitGroupEvents(projectPath, groupId, claimEvents, writer);

        // Launch execution — fire-and-forget into inFlight map
        const featureId = child.featureId;
        const execPromise = this._executeChild(
          projectPath,
          groupId,
          featureId,
          writer,
          signal
        ).finally(() => {
          inFlight.delete(featureId);
        });

        inFlight.set(featureId, execPromise);
        return true; // claimed one
      }

      return false; // nothing claimed this pass
    };

    // Main loop
    while (!signal.aborted) {
      const snapshot = await this.engine.getSnapshot(groupId);

      if (snapshot.status === 'cancelled') {
        logger.info(`[driveLoop] Group ${groupId} cancelled — stopping drive loop`);
        break;
      }

      // Try to fill all free slots
      let claimed = true;
      while (claimed) {
        claimed = await tryClaimOne();
      }

      // Re-check snapshot
      const snap2 = await this.engine.getSnapshot(groupId);
      if (snap2.status === 'cancelled') break;

      // Quiescence check: no children in pending/retrying/running
      const hasActive = snap2.children.some(
        (c) => c.status === 'pending' || c.status === 'retrying' || c.status === 'running'
      );

      if (!hasActive) {
        // Quiescent — settle (group status is running at this point; not cancelled
        // because we checked above and broke out)
        if (!signal.aborted) {
          try {
            const settleEvents = await this.engine.settleGroup(groupId);
            await this.saveGroupSerialized(projectPath, groupId);
            this.emitGroupEvents(projectPath, groupId, settleEvents, writer);
          } catch (err) {
            logger.warn(`[driveLoop] settleGroup failed for ${groupId}:`, err);
          }
        }
        break;
      }

      // Wait for the next in-flight child to complete before trying to claim again
      if (inFlight.size > 0) {
        await Promise.race(inFlight.values());
      } else {
        // No in-flight but still active? Shouldn't happen in correct flow, but guard
        break;
      }
    }

    // Drain any remaining in-flight (for cancel: let them report, then exit)
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight.values());
    }

    await writer.close();
    logger.info(`[driveLoop] Group ${groupId} drive loop exited`);
  }

  private async _executeChild(
    projectPath: string,
    groupId: string,
    featureId: string,
    writer: EventLogWriter,
    signal: AbortSignal
  ): Promise<void> {
    let success = false;

    try {
      await this.executeFeature(
        projectPath,
        featureId,
        /* useWorktrees */ true,
        /* isAutoMode */ false
      );

      // Determine success by re-reading feature status.
      // executeFeature resolves Promise<void> regardless of outcome;
      // the terminal status tells us what happened.
      const feature = await this.loadFeature(projectPath, featureId);
      success = isFeatureSuccess(feature);
    } catch (err) {
      // Defensive — executeFeature should never throw, but handle just in case
      logger.warn(`[driveLoop] executeFeature threw for ${featureId}:`, err);
      success = false;
    }

    // If the group was cancelled while we were executing, still report (so
    // the child leaves 'running' state), but note the cancellation context.
    const snapshot = await this.engine.getSnapshot(groupId);
    if (snapshot.status === 'cancelled' && signal.aborted) {
      // Group is cancelled — report the child outcome so it leaves 'running',
      // but don't attempt settle (settleGroup guard: status==running required)
      try {
        if (success) {
          await this.engine.reportChildSuccess(groupId, featureId);
        } else {
          await this.engine.reportChildFailure(groupId, featureId, 'group cancelled');
        }
        await this.saveGroupSerialized(projectPath, groupId);
      } catch {
        // Swallow — group is done
      }
      return;
    }

    try {
      if (success) {
        const reportEvents = await this.engine.reportChildSuccess(groupId, featureId);
        await this.saveGroupSerialized(projectPath, groupId);
        this.emitGroupEvents(projectPath, groupId, reportEvents, writer);
      } else {
        const feature = await this.loadFeature(projectPath, featureId);
        const errorMsg = feature?.status
          ? `feature ended with status '${feature.status}'`
          : 'execution failed';
        const reportEvents = await this.engine.reportChildFailure(groupId, featureId, errorMsg);
        await this.saveGroupSerialized(projectPath, groupId);
        this.emitGroupEvents(projectPath, groupId, reportEvents, writer);
      }
    } catch (err) {
      logger.warn(`[driveLoop] report for ${featureId} in ${groupId} failed:`, err);
    }
  }
}
