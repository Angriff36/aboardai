/**
 * GroupService — per-project registry of {engine, store, queue} instances.
 *
 * Solves the boot-path problem: previously, GroupEngine/GroupStore/GroupQueue
 * were created as ephemeral instances at startup and were unreachable from routes.
 * GroupService owns one shared GroupEngine (the Manifest MemoryStore is global to
 * the engine instance) and per-project GroupStore + GroupQueue instances keyed by
 * projectPath.
 *
 * Usage:
 *   const { engine, store, queue } = await groupService.getProjectGroup(projectPath);
 */

import { GroupEngine } from '../groups/group-engine.js';
import { GroupStore } from '../groups/group-store.js';
import { GroupQueue } from './group-queue.js';
import type { ExecuteFeatureFn, LoadFeatureFn, LoadAllFeaturesFn } from './group-queue.js';
import type { EventEmitter } from '../lib/events.js';
import { createLogger } from '@aboardai/utils';

const logger = createLogger('GroupService');

interface ProjectGroup {
  engine: GroupEngine;
  store: GroupStore;
  queue: GroupQueue;
}

export class GroupService {
  /** Lazily-initialized shared engine (one engine hosts groups across all projects) */
  private _engine: GroupEngine | null = null;

  /** Per-project {store, queue} keyed by projectPath */
  private readonly _projects = new Map<string, ProjectGroup>();

  constructor(
    private readonly executeFeature: ExecuteFeatureFn,
    private readonly loadFeature: LoadFeatureFn,
    private readonly loadAllFeatures: LoadAllFeaturesFn,
    private readonly events: EventEmitter
  ) {}

  // ── Engine initialization ─────────────────────────────────────────────────────

  private async _getEngine(): Promise<GroupEngine> {
    if (!this._engine) {
      this._engine = await GroupEngine.create();
    }
    return this._engine;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Returns or creates the per-project group triple for a given projectPath.
   * Safe to call multiple times — creates once and caches.
   */
  async getProjectGroup(projectPath: string): Promise<ProjectGroup> {
    const existing = this._projects.get(projectPath);
    if (existing) return existing;

    const engine = await this._getEngine();
    const store = new GroupStore(projectPath);
    const queue = new GroupQueue(
      engine,
      store,
      this.executeFeature,
      this.loadFeature,
      this.loadAllFeatures,
      this.events
    );

    const group: ProjectGroup = { engine, store, queue };
    this._projects.set(projectPath, group);
    return group;
  }

  /**
   * Same as getProjectGroup but throws a clear error if initialization fails.
   * Use this in routes that require the group to be ready.
   */
  async ensureProject(projectPath: string): Promise<ProjectGroup> {
    try {
      return await this.getProjectGroup(projectPath);
    } catch (err) {
      throw new Error(
        `GroupService: failed to initialize group triple for project '${projectPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Boot recovery: load persisted groups for a project and restart drive loops.
   * Called at startup for each project in globalSettings.projects.
   */
  async resumeProject(projectPath: string): Promise<void> {
    const { queue } = await this.getProjectGroup(projectPath);
    await queue.resumeGroups(projectPath);
    logger.info(`[GroupService] Resumed groups for ${projectPath}`);
  }
}
