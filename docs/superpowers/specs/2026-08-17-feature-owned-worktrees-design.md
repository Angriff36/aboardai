# Feature-Owned Worktrees Design

## Problem

AboardAI currently treats a feature's `branchName` as its execution workspace identity. Features with the same branch resolve to the same git worktree. The creation UI defaults many features to the current branch, backlog planning assigns an entire plan to one branch, and groups write one base branch onto unassigned children. Concurrent agents can therefore edit the same checkout.

This contradicts the product's isolation promise and makes bulk feature development unsafe. The default must instead be one feature, one branch, and one worktree. Sharing a workspace remains available only as an explicit choice.

## Goals

- Give every new feature a stable, unique branch and worktree by default.
- Provision the checkout lazily when execution begins so a large backlog does not immediately consume disk space.
- Allow independent features and group children to execute concurrently without writing to the same directory.
- Keep `Current Branch` and custom shared branches as explicit optional modes.
- Migrate legacy backlog features automatically without forcing the user to edit them individually.
- Remove successfully merged worktrees when safe, while retaining work needed for review or conflict resolution.
- Prevent any execution path, including manual starts, from running two agents in one worktree.

## Non-goals

- Duplicating the repository's git object database for every feature.
- Automatically deleting dirty, unmerged, conflicted, or waiting-for-review worktrees.
- Changing dependency ordering, model selection, orchestration roles, or provider behavior.
- Running package installation in every worktree unless the project's existing worktree initialization script requests it.

## Approaches Considered

### 1. Eager feature worktrees

Create a unique branch and checkout as soon as every feature card is created. This is simple and immediately visible, but a plan containing hundreds of features creates hundreds of full working directories even if only a few run.

### 2. Lazy feature-owned worktrees (selected)

Assign a stable unique branch and base branch when a feature is created, then create the checkout immediately before execution. This preserves feature identity and concurrency while only consuming checkout space for active or retained work. Dependency-gated features are based on the latest base branch when they actually become runnable.

### 3. Reusable worktree pool

Lease a small number of generic worktrees to features and reset them between runs. This reduces checked-out files but makes review, recovery, follow-up prompts, conflicts, and branch ownership much harder to reason about. It also reintroduces workspace reuse as a correctness risk.

## Data Model

Extend `Feature` with:

```ts
type FeatureWorktreeMode = 'isolated' | 'shared';

interface Feature {
  worktreeMode?: FeatureWorktreeMode;
  branchName?: string;
  worktreeBaseBranch?: string;
}
```

- `isolated` is the default for newly created features.
- `branchName` is the stable feature-owned branch in isolated mode.
- `worktreeBaseBranch` records the branch or ref from which a lazy worktree is created.
- `shared` means the user explicitly chose `Current Branch` or a custom shared branch.
- The worktree path remains derived from git's branch-to-worktree mapping and is not persisted in feature JSON.

Feature branch names use a deterministic collision-resistant form:

```text
feature/<title-slug>-<feature-id-prefix>
```

The feature ID makes the name stable even when the title changes and prevents two identical titles from sharing a branch.

## Creation Flows

### Add, Quick Add, templates, and spawned features

- Default to isolated mode whenever global worktrees are enabled.
- Generate and persist the unique feature branch, but do not create its checkout yet.
- `Current Branch` explicitly saves shared mode and the selected branch.
- `Custom Branch` explicitly saves shared mode and the chosen branch.
- Rename `Auto Worktree` to `Isolated Worktree` so the choice describes ownership rather than timing.

### Backlog planning

- Treat the selected branch as `worktreeBaseBranch`, never as every feature's `branchName`.
- Generate a unique isolated branch for each added feature.
- Updates preserve an existing feature's worktree fields unless the plan explicitly changes worktree mode through a supported UI action.

### Groups

- Treat the group's `baseBranch` as each child's `worktreeBaseBranch`.
- Ensure every eligible child is isolated before concurrent execution.
- Never write the same base branch into every child's `branchName`.
- Existing explicitly shared children are converted to isolated mode when added to a concurrent group, because group concurrency promises independent execution.

### Legacy features

Before a non-terminal legacy feature executes:

- Missing `worktreeMode` is migrated to `isolated`.
- Its previous `branchName`, or the repository primary branch when absent, becomes `worktreeBaseBranch`.
- A new feature-owned `branchName` is generated and persisted atomically.
- Running features are not migrated mid-execution.
- Terminal features remain unchanged unless the user reopens or follows up on them; reopening provisions isolated state before new work begins.

This migration is lazy and automatic, so existing backlogs do not create hundreds of directories at startup.

## Execution Lifecycle

1. Load the feature.
2. Normalize or migrate its worktree assignment.
3. For isolated mode, call the guarded `ensureWorktree(projectPath, branchName, { baseBranch })` operation.
4. For shared mode, resolve the explicitly selected branch/worktree.
5. Acquire a workspace lease keyed by the normalized absolute worktree path.
6. Start the agent only after the lease succeeds.
7. Hold the lease through implementation, tests, review orchestration, and pipeline operations.
8. Release the lease in a `finally` path on success, rejection, cancellation, or failure.

The existing feature-level lease continues preventing duplicate starts of the same feature. The new workspace lease prevents different feature IDs from writing to one checkout. Shared-mode work is serialized rather than allowed to collide.

## Merge and Cleanup

An isolated worktree is automatically removed only when all of the following are true:

- Its feature branch was successfully merged into the intended target.
- The worktree is clean.
- No agent, development server, test process, or orchestration round still holds the workspace lease.
- The feature is not in `waiting_approval`, `merge_conflict`, `interrupted`, or another recoverable state.

The local feature branch may be deleted after confirmed merge. Cleanup failure is non-fatal: the feature remains successful and AboardAI reports the retained path for later cleanup.

Worktrees are retained for review, rejected orchestration rounds, failed tests, conflicts, interrupted agents, and manual follow-up. A later successful merge triggers cleanup again.

## Disk Usage

Git worktrees share the repository's object database and history. Each active feature adds one checked-out copy of tracked files plus any untracked/generated files created there. The main disk risks are dependency directories and build artifacts, not duplicated git history.

The design limits usage by:

- Creating checkouts only when a feature actually starts.
- Removing clean worktrees after successful merge.
- Retaining only work that still needs review or recovery.
- Continuing to respect `.gitignore` and the project's existing initialization script.
- Exposing retained worktrees in the existing worktree UI so they can be cleaned deliberately.

No automatic cleanup may delete dirty or unmerged work.

## Concurrency Rules

- Different isolated features may run concurrently up to the configured project/group/model limits.
- A normalized worktree path may have at most one active execution owner.
- Manual `Make`, auto mode, resume, follow-up, group execution, and orchestration all use the same workspace lease.
- Auto mode no longer treats a branch-scoped concurrency count as permission for multiple writers; branch/worktree capacity is always one.
- Global and provider concurrency settings govern how many distinct worktrees may run simultaneously.

## Failure Handling

- Worktree creation failure returns the feature to a recoverable non-running state with the git error visible.
- A missing or deleted checkout is recreated from the persisted feature branch/base information.
- Workspace contention queues or defers the feature instead of starting a second writer.
- Migration persistence must complete before agent execution begins.
- Cleanup errors never discard work and never change a successful merge into a failed implementation.

## UI Behavior

- `Isolated Worktree` is the selected default when worktrees are enabled.
- The feature editor shows both the owned branch and its base branch.
- Shared modes display a warning that features on that branch execute serially.
- Bulk and planned feature creation state that each feature receives its own lazy worktree.
- The worktree bar continues grouping by actual checkout, but each active isolated feature normally has its own entry.
- Existing manually shared features remain visibly grouped until their automatic migration occurs or the user explicitly changes their mode.

## Testing

### Unit tests

- Stable unique branch generation for duplicate titles and title edits.
- Legacy feature migration from unassigned, primary, and non-primary branches.
- Plan application creates unique branches with a shared base.
- Group creation assigns unique child branches rather than one shared branch.
- Workspace lease rejects or serializes a second feature for the same normalized path.
- Cleanup only removes clean, merged, inactive worktrees.

### Integration tests

- Two isolated features start concurrently in different directories.
- Two shared features never execute concurrently in the same directory.
- Manual starts cannot bypass the workspace lease.
- A dependency-gated feature lazily branches from the updated base after its dependency merges.
- A rejected orchestrated feature retains and reuses its owned worktree across repair rounds.
- A successful merge removes the clean worktree; conflicts and waiting approval retain it.

### UI tests

- Add Feature defaults to isolated mode when worktrees are enabled.
- Quick Add and templates create isolated feature assignments.
- Plan-created features show separate owned branches.
- Explicit Current/Custom modes remain available and show serialization guidance.

## Acceptance Criteria

- Creating or planning multiple features produces a distinct branch identity for every feature by default.
- Starting multiple eligible features runs them in distinct worktree paths.
- No code path can run two feature agents in the same worktree simultaneously.
- Existing non-terminal backlog features migrate automatically when first executed.
- Explicit shared-branch operation remains available and is serialized.
- Clean successfully merged feature worktrees are removed automatically.
- Dirty, unmerged, conflicted, rejected, or waiting-for-review worktrees are never automatically deleted.
- A backlog of inactive features consumes no additional checkout space until features start.
