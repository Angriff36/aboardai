/**
 * group-store.ts — Persistence layer for TaskGroup snapshots.
 *
 * Stores each group snapshot atomically to:
 *   {projectPath}/.aboardai/groups/{groupId}/group.json
 *
 * Called after every successful command.
 * loadAllGroups() reads all snapshots for boot rehydration.
 */

import path from 'path';
import fs from 'fs/promises';
import { atomicWriteJson, readJsonWithRecovery } from '@aboardai/utils';
import type { TaskGroupSnapshot } from '@aboardai/types';

export class GroupStore {
  private readonly groupsDir: string;

  constructor(projectPath: string) {
    this.groupsDir = path.join(projectPath, '.aboardai', 'groups');
  }

  /** Persist a snapshot atomically to .aboardai/groups/{groupId}/group.json */
  async saveGroup(snapshot: TaskGroupSnapshot): Promise<void> {
    const groupDir = path.join(this.groupsDir, snapshot.id);
    await fs.mkdir(groupDir, { recursive: true });
    const filePath = path.join(groupDir, 'group.json');
    await atomicWriteJson(filePath, snapshot);
  }

  /** Load all persisted group snapshots for boot rehydration */
  async loadAllGroups(): Promise<TaskGroupSnapshot[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.groupsDir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return [];
      throw err;
    }

    const snapshots: TaskGroupSnapshot[] = [];
    for (const entry of entries) {
      const filePath = path.join(this.groupsDir, entry, 'group.json');
      const result = await readJsonWithRecovery<TaskGroupSnapshot | null>(filePath, null);
      if (result.data !== null) {
        snapshots.push(result.data);
      }
    }
    return snapshots;
  }
}
