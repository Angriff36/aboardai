/**
 * Task Group types for AboardAI
 *
 * Models the lifecycle of a TaskGroup — a collection of 2–20 features
 * that run concurrently (up to maxConcurrency), with per-child retry,
 * shared base branch, and a settled outcome of 'review' or 'failed'.
 */

/** Status of a single child feature within a TaskGroup */
export type GroupChildStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Overall lifecycle status of a TaskGroup */
export type TaskGroupStatus = 'pending' | 'running' | 'review' | 'failed' | 'cancelled';

/** A snapshot of a TaskGroup at a point in time — the persisted shape */
export interface TaskGroupSnapshot {
  id: string;
  name: string;
  /** Shared base branch for children without an explicit branchName; null = main worktree */
  baseBranch: string | null;
  /** Maximum number of children that may be running concurrently (1–10) */
  maxConcurrency: number;
  /** Maximum number of retries per child (0–5) */
  retryLimit: number;
  status: TaskGroupStatus;
  children: Array<{
    featureId: string;
    status: GroupChildStatus;
    /** How many times this child has been attempted (starts at 0, incremented on each failure) */
    attempts: number;
    /** Set on terminal failure (attempts > retryLimit) */
    lastError?: string;
  }>;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}
