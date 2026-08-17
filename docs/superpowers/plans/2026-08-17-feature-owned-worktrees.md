# Feature-Owned Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make isolated, lazily provisioned, feature-owned git worktrees the default for every creation path while serializing explicitly shared workspaces and safely cleaning merged worktrees.

**Architecture:** Add a pure feature-worktree assignment service for deterministic branches and legacy migration. Persist assignment metadata in every feature, provision its checkout at execution time, and guard the normalized checkout path with a workspace lease used by every execution mode. Planning and groups provide a base branch rather than one shared execution branch.

**Tech Stack:** TypeScript, React 19, Express 5, Zustand, Vitest, Playwright, git worktrees.

## Global Constraints

- Default behavior is one feature, one branch, and one lazily created worktree.
- `Current Branch` and custom shared branches remain explicit optional modes.
- No execution path may run two agents in the same normalized checkout path.
- Existing non-terminal features without explicit worktree metadata migrate before execution.
- Never delete dirty, unmerged, conflicted, rejected, interrupted, or waiting-for-review work.
- Preserve unrelated dirty and untracked files.

---

### Task 1: Persisted Feature Worktree Assignment

**Files:**

- Modify: `libs/types/src/feature.ts`
- Create: `apps/server/src/services/feature-worktree-assignment.ts`
- Create: `apps/server/tests/unit/services/feature-worktree-assignment.test.ts`
- Modify: `apps/server/src/services/feature-loader.ts`
- Modify: `apps/server/tests/unit/services/feature-loader.test.ts`

**Interfaces:**

- Produces `FeatureWorktreeMode = 'isolated' | 'shared'`.
- Produces `createFeatureBranchName(featureId: string, title?: string): string`.
- Produces `buildDefaultWorktreeAssignment(feature, baseBranch?)`.
- Produces `normalizeFeatureWorktreeAssignment(feature, primaryBranch)`.

- [ ] Write failing tests proving duplicate titles receive different branches, persisted branches survive title edits, explicit shared features are unchanged, and legacy primary/non-primary assignments migrate with their old branch retained as `worktreeBaseBranch`.
- [ ] Run `npm run test:server -- tests/unit/services/feature-worktree-assignment.test.ts` and verify failures are caused by missing assignment behavior.
- [ ] Add `worktreeMode`, `branchName`, and `worktreeBaseBranch` to `Feature`. Generate `feature/<title-slug>-<sha256(featureId)[0..8]>` branches.
- [ ] Add a failing `FeatureLoader.create()` test for isolated defaults and explicit shared preservation.
- [ ] Apply defaults after the final feature ID is known, then run `npm run test:server -- tests/unit/services/feature-worktree-assignment.test.ts tests/unit/services/feature-loader.test.ts`.
- [ ] Commit with `git commit -m "[feat] give every feature a stable worktree identity"`.

---

### Task 2: Lazy Provisioning and Workspace Leases

**Files:**

- Create: `apps/server/src/services/workspace-lease-manager.ts`
- Create: `apps/server/tests/unit/services/workspace-lease-manager.test.ts`
- Modify: `apps/server/src/services/execution-types.ts`
- Modify: `apps/server/src/services/execution-service.ts`
- Modify: `apps/server/src/services/auto-mode/facade.ts`
- Modify: `apps/server/tests/unit/services/execution-service.test.ts`

**Interfaces:**

- Produces `WorkspaceLeaseManager.acquire(path, featureId, signal?): Promise<() => void>`.
- Adds injected persistence and guarded-provisioning callbacks to `ExecutionService`.
- Consumes Task 1 normalization plus existing `ensureWorktree()`.

- [ ] Write failing lease tests: slash/case variants of one Windows path serialize, distinct paths acquire concurrently, release wakes the next waiter, and abort removes a waiter.
- [ ] Run `npm run test:server -- tests/unit/services/workspace-lease-manager.test.ts` and verify RED.
- [ ] Implement an idempotent release callback, normalized path keys, FIFO waiters, and empty-queue cleanup.
- [ ] Write failing execution tests proving legacy migration persists before the agent starts, isolated work calls `ensureWorktree` with owned/base branches, missing checkouts are recreated, shared paths serialize, and every terminal path releases its lease.
- [ ] Run `npm run test:server -- tests/unit/services/execution-service.test.ts` and verify RED.
- [ ] Change execution order to load, normalize, persist, provision/resolve, lease, then execute. Hold the lease through planning, implementation, pipelines, orchestration, cancellation, and failure; release from the outermost `finally`.
- [ ] Inject real callbacks from `auto-mode/facade.ts`. Isolated mode uses `ensureWorktree`; shared primary mode uses the project checkout; other shared branches resolve existing worktrees.
- [ ] Run `npm run test:server -- tests/unit/services/workspace-lease-manager.test.ts tests/unit/services/execution-service.test.ts tests/unit/services/worktree-creation.test.ts`.
- [ ] Commit with `git commit -m "[feat] provision and lease feature worktrees at execution"`.

---

### Task 3: Unique Plan and Group Assignments

**Files:**

- Modify: `apps/server/src/routes/backlog-plan/routes/apply.ts`
- Modify: `apps/server/tests/unit/routes/backlog-plan/apply.test.ts`
- Modify: `apps/server/src/routes/groups/routes/create.ts`
- Modify: `apps/server/tests/unit/routes/groups/create.test.ts`
- Modify: `apps/server/tests/unit/services/group-queue.test.ts`

**Interfaces:**

- Backlog-plan `branchName` remains wire-compatible but becomes the feature base branch.
- Group `baseBranch` becomes each child's base, never its execution branch.

- [ ] Add a failing plan test with two same-title additions; assert distinct isolated branches and one shared `worktreeBaseBranch`.
- [ ] Run `npm run test:server -- tests/unit/routes/backlog-plan/apply.test.ts` and verify the current shared-branch behavior fails.
- [ ] Pass isolated mode plus `worktreeBaseBranch` into FeatureLoader rather than assigning the selected branch to `branchName`.
- [ ] Add failing group tests proving every child receives a distinct isolated branch based on the group base.
- [ ] Run `npm run test:server -- tests/unit/routes/groups/create.test.ts tests/unit/services/group-queue.test.ts` and verify RED.
- [ ] Replace direct JSON writeback with `FeatureLoader.update()` using Task 1 assignment helpers.
- [ ] Run all three focused files and commit with `git commit -m "[fix] isolate planned and grouped feature execution"`.

---

### Task 4: Clean-Only Post-Merge Cleanup

**Files:**

- Modify: `apps/server/src/services/merge-service.ts`
- Modify: `apps/server/src/services/pipeline-orchestrator.ts`
- Create: `apps/server/tests/unit/services/merge-service-cleanup.test.ts`
- Modify: `apps/server/tests/unit/services/pipeline-orchestrator.test.ts`

**Interfaces:**

- `performMerge(..., { deleteWorktreeAndBranch: true })` cleans only a clean merged checkout.
- Pipeline requests cleanup only for `feature.worktreeMode === 'isolated'`.

- [ ] Using temporary real repositories, write failing tests proving clean merged worktrees are removed but dirty worktrees and branches remain.
- [ ] Run `npm run test:server -- tests/unit/services/merge-service-cleanup.test.ts` and verify current forced deletion fails the dirty case.
- [ ] After merge, inspect `git status --porcelain` in the worktree. Skip all deletion when dirty; otherwise use non-forced `git worktree remove`, prune stale metadata only, and delete with `git branch -d`.
- [ ] Add a failing pipeline test that distinguishes isolated from shared cleanup policy.
- [ ] Pass `deleteWorktreeAndBranch: feature.worktreeMode === 'isolated'`, run both focused files, and commit with `git commit -m "[fix] clean merged feature worktrees without discarding work"`.

---

### Task 5: UI Defaults and Explicit Shared Modes

**Files:**

- Modify: `apps/ui/src/components/views/board-view/shared/work-mode-selector.tsx`
- Modify: `apps/ui/src/components/views/board-view/dialogs/add-feature-dialog.tsx`
- Modify: `apps/ui/src/components/views/board-view/hooks/use-board-actions.ts`
- Modify: `apps/ui/src/components/views/board-view.tsx`
- Create: `apps/ui/tests/unit/components/work-mode-selector.test.tsx`
- Modify: `apps/ui/tests/features/add-feature-to-backlog.spec.ts`

**Interfaces:**

- Keep transient UI values `current | auto | custom` for compatibility.
- Map `auto` to isolated mode plus a base branch.
- Map `current` and `custom` to shared mode.

- [ ] Write failing tests for the `Isolated Worktree` label, lazy-creation copy, shared serialization warning, and isolated Add Feature default when worktrees are enabled.
- [ ] Run `npm --workspace apps/ui run test:unit -- tests/unit/components/work-mode-selector.test.tsx` and verify RED.
- [ ] Remove eager worktree creation for `auto`; let the server return canonical assignment. Keep custom creation only for an explicit custom branch.
- [ ] Make Quick Add, Quick Add & Start, templates, duplicates, and spawned features select isolated mode when worktrees are enabled.
- [ ] Update the Add Feature browser test to assert isolated intent with no shared current-branch assignment.
- [ ] Run the focused UI unit and browser tests and commit with `git commit -m "[feat] default every feature to an isolated worktree"`.

---

### Task 6: Full Verification and Electron Package

**Files:**

- Modify only files required by verified regressions.

- [ ] Run `npm run build:packages`, `npm run build:server`, and `npm --workspace apps/ui run typecheck`.
- [ ] Run all focused server worktree, execution, plan, group, merge, and pipeline tests from Tasks 1-4.
- [ ] Run `npm --workspace apps/ui run test:unit -- tests/unit/components/work-mode-selector.test.tsx`.
- [ ] Run `npm run test:packages`, `npm run test:server`, and `npm --workspace apps/ui run test:unit`.
- [ ] Run `npm run format:check` and `git diff --check`.
- [ ] Run `npm run build:electron` and record installer path, size, timestamp, SHA-256, and Authenticode status.
- [ ] Inspect `git status --short`, `git diff --stat main...HEAD`, and `git log --oneline main..HEAD`; commit only verification-driven fixes while preserving unrelated user files.
