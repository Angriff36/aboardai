# Bulk Feature Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selection-mode action that applies any existing Enhance with AI mode to all selected backlog features in the current worktree or branch.

**Architecture:** Keep `/api/enhance-prompt` and every prompt definition unchanged. A tested client queue will call that existing route and the existing single-feature update route with bounded concurrency, while a focused dialog owns mode selection, progress, partial-failure reporting, and retry.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Radix UI components, existing HTTP/Electron API facade.

## Global Constraints

- Preserve all five existing enhancement modes, labels, prompts, examples, and rewrite-versus-append behavior.
- Scope the operation to selected backlog features in the currently viewed worktree or branch.
- Save successful feature descriptions immediately and preserve description history metadata.
- Isolate per-feature failures; retain successful updates and allow failed items to be retried.
- Use bounded concurrency so a large backlog does not flood the configured AI provider.
- Preserve all unrelated dirty working-tree changes.

---

### Task 1: Shared enhancement composition and queue

**Files:**

- Create: `apps/ui/src/components/views/board-view/shared/enhancement/bulk-enhancement.ts`
- Modify: `apps/ui/src/components/views/board-view/shared/enhancement/enhance-with-ai.tsx`
- Test: `apps/ui/tests/unit/lib/bulk-enhancement.test.ts`

**Interfaces:**

- Produces: `composeEnhancedDescription(originalText, generatedText, mode): string`.
- Produces: `runBulkEnhancement(options): Promise<BulkEnhancementResult>` with ordered success IDs, `{ featureId, error }` failures, and progress callbacks.
- Consumes: existing `EnhancementMode`, existing `/api/enhance-prompt` response shape, and existing feature-update response shape.

- [ ] **Step 1: Write failing composition tests**

```ts
expect(composeEnhancedDescription('Original', 'Clear rewrite', 'improve')).toBe('Clear rewrite');
expect(composeEnhancedDescription('Original ', ' Criteria ', 'acceptance')).toBe(
  'Original\n\nCriteria'
);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run --config apps/ui/vitest.config.ts apps/ui/tests/unit/lib/bulk-enhancement.test.ts`

Expected: FAIL because `bulk-enhancement.ts` does not exist.

- [ ] **Step 3: Implement composition and refactor the single enhancer to use it**

```ts
export function composeEnhancedDescription(
  originalText: string,
  generatedText: string,
  mode: EnhancementMode
): string {
  return isAdditiveMode(mode) ? `${originalText.trim()}\n\n${generatedText.trim()}` : generatedText;
}
```

Replace the inline additive-mode branch in `EnhanceWithAI` with this helper so bulk and individual enhancement cannot drift.

- [ ] **Step 4: Write failing queue tests**

Cover these observable behaviors with literal fixtures:

```ts
expect(result.succeededIds).toEqual(['feature-1', 'feature-3']);
expect(result.failures).toEqual([{ featureId: 'feature-2', error: 'provider failed' }]);
expect(progress.at(-1)).toEqual({ completed: 3, total: 3, failed: 1 });
expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
```

The save fixture must capture the final description and history arguments, proving additive composition and `source: enhance` metadata reach the real queue boundary.

- [ ] **Step 5: Run the queue tests and confirm RED**

Run the same focused Vitest command.

Expected: FAIL because `runBulkEnhancement` is not exported.

- [ ] **Step 6: Implement the bounded worker queue**

```ts
export interface BulkEnhancementProgress {
  completed: number;
  total: number;
  failed: number;
}

export interface BulkEnhancementResult {
  succeededIds: string[];
  failures: Array<{ featureId: string; error: string }>;
}
```

Use two workers by default. For each feature: call `enhance`, reject empty/failed responses, compose the final description, call `save`, record the result, and emit progress in a `finally` block. Sort result IDs back into input order before returning.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run the same focused Vitest command and confirm every test passes.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/ui/src/components/views/board-view/shared/enhancement/bulk-enhancement.ts apps/ui/src/components/views/board-view/shared/enhancement/enhance-with-ai.tsx apps/ui/tests/unit/lib/bulk-enhancement.test.ts
git commit -m "[feat] share bulk enhancement execution logic"
```

### Task 2: Bulk-enhancement dialog and selection action

**Files:**

- Create: `apps/ui/src/components/views/board-view/dialogs/bulk-enhance-dialog.tsx`
- Modify: `apps/ui/src/components/views/board-view/dialogs/index.ts`
- Modify: `apps/ui/src/components/views/board-view/components/selection-action-bar.tsx`
- Test: `apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx`
- Test: `apps/ui/tests/unit/components/selection-action-bar.test.tsx`

**Interfaces:**

- Produces: `BulkEnhanceDialog` with `open`, `featureCount`, `onOpenChange`, `onRun`, and `onFinished` props.
- Produces: `SelectionActionBar.onEnhance?: () => void`.
- Consumes: enhancement constants, `ModelOverrideTrigger`, `useModelOverride`, `BulkEnhancementProgress`, and `BulkEnhancementResult`.

- [ ] **Step 1: Write failing selection-action test**

Render backlog mode with `onEnhance={handler}`, click the accessible **Enhance Selected** button, and assert the real handler was called once. Render waiting-approval mode and assert that button is absent.

- [ ] **Step 2: Run the focused selection test and confirm RED**

Run: `npx vitest run --config apps/ui/vitest.config.ts apps/ui/tests/unit/components/selection-action-bar.test.tsx`

Expected: FAIL because the action and prop do not exist.

- [ ] **Step 3: Add the selection action**

Add a brand-styled button with a `Sparkles` icon, `data-testid="selection-enhance-button"`, and disabled state when no features are selected.

- [ ] **Step 4: Write failing dialog behavior tests**

Test real rendered states:

- Setup uses the unchanged mode labels and defaults to **Improve Clarity**.
- Starting a run displays `0 of N`, disables closing, and forwards mode/model options.
- Progress updates display completed and failed counts.
- Complete success offers **Done**.
- Partial failure lists failed feature names and offers **Retry Failed** with exactly those IDs.

- [ ] **Step 5: Run the focused dialog test and confirm RED**

Run: `npx vitest run --config apps/ui/vitest.config.ts apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx`

Expected: FAIL because `BulkEnhanceDialog` does not exist.

- [ ] **Step 6: Implement the dialog**

Reuse `ENHANCEMENT_MODE_LABELS`, `REWRITE_MODES`, and `ADDITIVE_MODES` for the dropdown. Use `useModelOverride({ phase: 'enhancementModel' })`; pass its effective model and thinking level through `onRun`. Reset state each time a new batch opens, block dialog dismissal during `running`, and keep the chosen mode for retries.

- [ ] **Step 7: Export and verify the components**

Run both focused component test files and confirm GREEN.

- [ ] **Step 8: Commit Task 2**

```bash
git add apps/ui/src/components/views/board-view/dialogs/bulk-enhance-dialog.tsx apps/ui/src/components/views/board-view/dialogs/index.ts apps/ui/src/components/views/board-view/components/selection-action-bar.tsx apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx apps/ui/tests/unit/components/selection-action-bar.test.tsx
git commit -m "[feat] add bulk enhancement controls and progress"
```

### Task 3: Board integration and end-to-end verification

**Files:**

- Modify: `apps/ui/src/components/views/board-view.tsx`
- Test: `apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx`

**Interfaces:**

- Consumes: `runBulkEnhancement`, `BulkEnhanceDialog`, `selectedFeatures`, `selectAll`, `loadFeatures`, and the existing HTTP client.
- Produces: a board handler that enhances/saves selected or retry-only features and preserves feature description history.

- [ ] **Step 1: Add a failing integration-boundary test**

Exercise the dialog's `onRun` contract with a real `runBulkEnhancement` queue and API-shaped fixtures. Assert that save receives:

```ts
[projectPath, 'feature-1', { description: 'Clear rewrite' }, 'enhance', 'improve', 'Original'];
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run the dialog test command and confirm it fails because board-compatible orchestration is missing.

- [ ] **Step 3: Wire the board**

Add `showBulkEnhanceDialog` state. Open it from `SelectionActionBar.onEnhance`. In the run handler, filter `selectedFeatures` by optional retry IDs, call the unchanged enhancement API with mode/model/thinking/project path, and save through `api.features.update(projectPath, id, { description }, 'enhance', mode, originalDescription)`.

After each run, call `loadFeatures()`. On complete success, close the dialog and `exitSelectionMode()`. On partial failure, call `selectAll(failedIds)` and keep the dialog open for retry.

- [ ] **Step 4: Run focused tests, typecheck, lint, and build**

```bash
npx vitest run --config apps/ui/vitest.config.ts apps/ui/tests/unit/lib/bulk-enhancement.test.ts apps/ui/tests/unit/components/selection-action-bar.test.tsx apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx
npm run typecheck
npm run lint:errors
npm run build
```

Expected: every command exits 0. If unrelated baseline failures occur, record their exact files and keep feature verification separate.

- [ ] **Step 5: Browser smoke test**

Run the existing app in web mode, enter backlog selection mode, select multiple features, and verify the new action opens the five-mode dialog. Use mock-agent or intercepted enhancement responses so no paid/provider calls are made. Confirm progress, saved descriptions, partial failure retention, and retry visually.

- [ ] **Step 6: Review the final diff for scope safety**

Run `git diff --check`, `git status --short`, and focused `git diff -- <owned files>`. Confirm prompt files and unrelated dirty files are untouched.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/ui/src/components/views/board-view.tsx apps/ui/tests/unit/components/bulk-enhance-dialog.test.tsx
git commit -m "[feat] bulk enhance selected backlog features"
```
