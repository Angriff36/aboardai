# Balanced Model Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional backlog-only action that verifies real access to selected AI models, previews a deterministic balanced spread, and applies exact model settings to selected features without changing existing manual selectors.

**Architecture:** Extract the existing enabled feature-model inventory into a reusable catalog hook consumed by both `PhaseModelSelector` and a new `BalanceModelsDialog`. Keep distribution and bulk-update behavior in pure/focused modules, while a new server endpoint performs bounded, read-only probes through the existing provider stack. The board owns the selected-feature snapshot and applies independent feature updates only after a verified preview is confirmed.

**Tech Stack:** TypeScript, React 19, Zustand, TanStack Query, Express 5, Vitest, Testing Library, Playwright.

## Global Constraints

- The action applies only to selected backlog features; running, waiting-approval, verified, completed, and archived features are never included.
- Existing per-feature model selection, Mass Edit model selection, defaults, and automatic execution behavior remain unchanged.
- Automatic mode chooses at most one enabled representative model per execution provider/subscription.
- Manual mode accepts one or more enabled catalog entries and preserves provider, thinking, and reasoning configuration.
- Every candidate assigned in the current dialog session must pass a real minimal probe before Apply is enabled.
- Verification uses the exact model/provider profile, `readOnly: true`, `allowedTools: []`, `maxTurns: 1`, bounded concurrency, and an abort timeout.
- No feature write occurs before the user confirms the preview with `Apply Distribution`.
- Assignment order is deterministic round-robin over board-ordered features and display-ordered verified candidates.
- Feature writes set `model`, `providerId`, `thinkingLevel`, and `reasoningEffort`; non-applicable optional fields are explicitly cleared.
- Full success exits selection mode; partial failure retains only failed feature IDs and can retry without resaving successes.
- The UI must remain keyboard accessible and must not communicate verification state by color alone.
- Browser verification must intercept verification/update responses and consume no live subscription credits or feature data.

---

## File Map

- `libs/types/src/model-distribution.ts`: shared API contracts for normalized candidates and verification results.
- `libs/types/src/index.ts`: exports the new contracts.
- `apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts`: constructs the single normalized enabled-model inventory used by selectors and distribution.
- `apps/ui/src/components/views/settings-view/model-defaults/phase-model-selector.tsx`: consumes the extracted catalog without changing current single-select behavior.
- `apps/ui/src/components/views/board-view/shared/model-distribution.ts`: pure automatic grouping, round-robin preview, and exact feature-patch helpers.
- `apps/ui/src/components/views/board-view/shared/bulk-model-assignment.ts`: bounded independent feature writes, progress, and retry results.
- `apps/server/src/services/model-access-verifier.ts`: exact provider resolution, safe timeout/error handling, and bounded probes.
- `apps/server/src/routes/models/routes/verify-access.ts`: validates HTTP input and returns per-candidate results.
- `apps/server/src/routes/models/index.ts`: mounts the verification endpoint with `SettingsService` injection.
- `apps/server/src/index.ts`: passes the existing settings service into model routes.
- `apps/ui/src/lib/http-api-client.ts`: typed verification client method.
- `apps/ui/src/components/views/board-view/dialogs/balance-models-dialog.tsx`: automatic/manual selection, verification, preview, apply, progress, and retry UI.
- `apps/ui/src/components/views/board-view/components/selection-action-bar.tsx`: adds the optional `Balance Models` entry point.
- `apps/ui/src/components/views/board-view.tsx`: snapshots selected backlog features, opens the dialog, refreshes features, and updates selection after completion.
- Unit/component/browser tests listed in the tasks below prove each boundary.

---

### Task 1: Shared Contracts and Pure Distribution Engine

**Files:**

- Create: `libs/types/src/model-distribution.ts`
- Modify: `libs/types/src/index.ts`
- Create: `apps/ui/src/components/views/board-view/shared/model-distribution.ts`
- Test: `apps/ui/tests/unit/lib/model-distribution.test.ts`

**Interfaces:**

- Produces:
  - `ModelAssignmentCandidate { key; model; displayName; providerKey; providerLabel; providerId?; thinkingLevel?; reasoningEffort?; isProviderDefault }`
  - `ModelAccessVerificationResult { key; status: 'verified' | 'unavailable'; error?: string }`
  - `createAutomaticCandidates(candidates): ModelAssignmentCandidate[]`
  - `distributeModels(featureIds, candidates): ModelDistributionPreview`
  - `toFeatureModelPatch(candidate): Pick<Feature, 'model' | 'providerId' | 'thinkingLevel' | 'reasoningEffort'>`

- [ ] **Step 1: Write the failing distribution tests**

Cover stable round-robin output, input immutability, count spread `<= 1`, display-order preservation, one default-or-first representative per `providerKey`, empty input rejection, and explicit clearing of non-applicable fields:

```ts
expect(distributeModels(['f1', 'f2', 'f3'], [cursor, codex])).toEqual({
  assignments: [
    { featureId: 'f1', candidate: cursor },
    { featureId: 'f2', candidate: codex },
    { featureId: 'f3', candidate: cursor },
  ],
  counts: [
    { candidate: cursor, count: 2 },
    { candidate: codex, count: 1 },
  ],
});
expect(toFeatureModelPatch(cursor)).toEqual({
  model: cursor.model,
  providerId: undefined,
  thinkingLevel: undefined,
  reasoningEffort: undefined,
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run apps/ui/tests/unit/lib/model-distribution.test.ts`

Expected: FAIL because the shared contracts and distribution module do not exist.

- [ ] **Step 3: Add the contracts and minimal pure implementation**

Use these exact shapes:

```ts
export interface ModelAssignmentCandidate extends PhaseModelEntry {
  key: string;
  displayName: string;
  providerKey: string;
  providerLabel: string;
  isProviderDefault: boolean;
}

export interface ModelDistributionPreview {
  assignments: Array<{ featureId: string; candidate: ModelAssignmentCandidate }>;
  counts: Array<{ candidate: ModelAssignmentCandidate; count: number }>;
}
```

`createAutomaticCandidates` groups by `providerKey`, returns the default entry when present, otherwise the first entry, and retains group display order. `distributeModels` rejects empty arrays and uses `candidates[index % candidates.length]`. `toFeatureModelPatch` always emits all four persisted keys so stale optional settings are cleared.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npx vitest run apps/ui/tests/unit/lib/model-distribution.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the pure foundation**

```powershell
git add libs/types/src/model-distribution.ts libs/types/src/index.ts apps/ui/src/components/views/board-view/shared/model-distribution.ts apps/ui/tests/unit/lib/model-distribution.test.ts
git commit -m "[feat] add balanced model distribution engine"
```

### Task 2: Reusable Enabled Feature-Model Catalog

**Files:**

- Create: `apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts`
- Modify: `apps/ui/src/components/views/settings-view/model-defaults/phase-model-selector.tsx`
- Test: `apps/ui/tests/unit/components/phase-model-selector.test.tsx`
- Create: `apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx`

**Interfaces:**

- Consumes: `ModelAssignmentCandidate` from Task 1.
- Produces: `useFeatureModelCatalog(): { candidates: ModelAssignmentCandidate[]; isLoading: boolean; error: Error | null }`.
- `providerKey` identifies the real subscription boundary: native providers use `claude`, `cursor`, `codex`, `opencode`, `gemini`, or `copilot`; Claude-compatible profiles use `claude-compatible:${providerId}`.

- [ ] **Step 1: Add failing catalog and regression tests**

Mock the same settings/model hooks already mocked by `phase-model-selector.test.tsx`. Assert that only enabled entries appear, dynamic model display order is stable, provider defaults set `isProviderDefault`, provider profiles remain distinct, and `PhaseModelSelector` still calls `onChange` with the exact existing `PhaseModelEntry` shape.

```ts
expect(result.current.candidates.map(({ key, providerKey }) => ({ key, providerKey }))).toEqual([
  { key: 'cursor:cursor-auto', providerKey: 'cursor' },
  { key: 'codex:gpt-5.2-codex', providerKey: 'codex' },
  { key: 'provider:zai:glm-5', providerKey: 'claude-compatible:zai' },
]);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/components/phase-model-selector.test.tsx`

Expected: the new hook test fails because the hook does not exist; existing selector tests remain green.

- [ ] **Step 3: Extract catalog construction and adapt the selector**

Move inventory-building decisions, enabled filters, labels, provider keys, defaults, and capability-derived thinking/reasoning values from `PhaseModelSelector` into the hook. Keep menus, current-value handling, callbacks, and styling inside `PhaseModelSelector`. Do not create a second hard-coded model list.

- [ ] **Step 4: Run catalog and selector tests and confirm GREEN**

Run: `npx vitest run apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/components/phase-model-selector.test.tsx`

Expected: PASS with unchanged selector behavior.

- [ ] **Step 5: Commit the shared catalog**

```powershell
git add apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts apps/ui/src/components/views/settings-view/model-defaults/phase-model-selector.tsx apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/components/phase-model-selector.test.tsx
git commit -m "[refactor] share enabled feature model catalog"
```

### Task 3: Bounded Exact-Access Verification API

**Files:**

- Create: `apps/server/src/services/model-access-verifier.ts`
- Create: `apps/server/src/routes/models/routes/verify-access.ts`
- Modify: `apps/server/src/routes/models/index.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/unit/services/model-access-verifier.test.ts`
- Test: `apps/server/tests/unit/routes/models/verify-access.test.ts`

**Interfaces:**

- Consumes: `ModelAssignmentCandidate`, `ModelAccessVerificationResult`, `SettingsService`, `resolveProviderContext`, and `simpleQuery`.
- Produces:

```ts
export type ModelProbe = (options: SimpleQueryOptions) => Promise<SimpleQueryResult>;

export async function verifyModelAccess(
  candidates: ModelAssignmentCandidate[],
  projectPath: string,
  settingsService: SettingsService,
  dependencies?: { probe?: ModelProbe; concurrency?: number; timeoutMs?: number }
): Promise<ModelAccessVerificationResult[]>;
```

- HTTP contract: `POST /api/models/verify-access` with `{ projectPath, candidates }`, returning `{ results }`.

- [ ] **Step 1: Write failing service tests**

Inject a fake probe and assert each exact candidate becomes:

```ts
expect(probe).toHaveBeenCalledWith(
  expect.objectContaining({
    prompt: 'Reply with only: ok',
    model: candidate.model,
    cwd: projectPath,
    maxTurns: 1,
    allowedTools: [],
    readOnly: true,
    thinkingLevel: candidate.thinkingLevel,
    reasoningEffort: candidate.reasoningEffort,
  })
);
```

For `providerId`, mock `resolveProviderContext` so the probe receives its exact `claudeCompatibleProvider`, resolved model, and credentials. Track simultaneous promises to prove concurrency never exceeds `3`. Assert timeout, authentication, billing, rate-limit, and generic errors return `{ status: 'unavailable' }` with concise sanitized messages while other candidates continue. Assert `ABOARDAI_MOCK_AGENT=true` returns deterministic verified results without calling the probe.

- [ ] **Step 2: Run the service tests and confirm RED**

Run: `npx vitest run --project=server apps/server/tests/unit/services/model-access-verifier.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement the verifier**

Use a worker-index loop with default concurrency `3`. Give each probe its own `AbortController`; call `abort()` after default `20_000` ms; always clear the timer. Never return raw error objects, stacks, credentials, paths, environment values, or provider payloads. Map known error text to concise categories such as `Authentication failed`, `Subscription or billing access unavailable`, `Rate limit reached`, `Verification timed out`, or `Provider request failed`.

- [ ] **Step 4: Run the service tests and confirm GREEN**

Run: `npx vitest run --project=server apps/server/tests/unit/services/model-access-verifier.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing route validation tests**

Construct the router with a mocked `SettingsService`. Assert `400` for missing/invalid project path, empty candidates, more than `20` candidates, duplicate keys, missing model/key/provider identity, and invalid thinking/reasoning values. Assert a valid request returns every independent verifier result in request order.

- [ ] **Step 6: Run the route tests and confirm RED**

Run: `npx vitest run --project=server apps/server/tests/unit/routes/models/verify-access.test.ts`

Expected: FAIL because the handler and injected route signature do not exist.

- [ ] **Step 7: Implement and mount the route**

Change the route factory to:

```ts
export function createModelsRoutes(settingsService: SettingsService): Router {
  const router = Router();
  router.get('/available', createAvailableHandler());
  router.get('/providers', createProvidersHandler());
  router.post('/verify-access', createVerifyAccessHandler(settingsService));
  return router;
}
```

Use the repository path guard already used by feature routes before calling the verifier. Validate a maximum of `20` candidates and return `400` JSON `{ error }` for malformed batches.

- [ ] **Step 8: Run both server tests and confirm GREEN**

Run: `npx vitest run --project=server apps/server/tests/unit/services/model-access-verifier.test.ts apps/server/tests/unit/routes/models/verify-access.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the verification boundary**

```powershell
git add apps/server/src/services/model-access-verifier.ts apps/server/src/routes/models/routes/verify-access.ts apps/server/src/routes/models/index.ts apps/server/src/index.ts apps/server/tests/unit/services/model-access-verifier.test.ts apps/server/tests/unit/routes/models/verify-access.test.ts
git commit -m "[feat] verify exact model access before assignment"
```

### Task 4: Typed Client and Recoverable Bulk Assignment Adapter

**Files:**

- Modify: `apps/ui/src/lib/http-api-client.ts`
- Create: `apps/ui/src/components/views/board-view/shared/bulk-model-assignment.ts`
- Test: `apps/ui/tests/unit/lib/bulk-model-assignment.test.ts`

**Interfaces:**

- Produces: `api.model.verifyAccess(projectPath, candidates): Promise<{ results: ModelAccessVerificationResult[] }>`.
- Produces:

```ts
export async function applyModelAssignments(
  assignments: ModelDistributionPreview['assignments'],
  updateFeature: (
    featureId: string,
    patch: ReturnType<typeof toFeatureModelPatch>
  ) => Promise<void>,
  options?: { concurrency?: number; onProgress?: (progress: AssignmentProgress) => void }
): Promise<{ succeededIds: string[]; failed: Array<{ featureId: string; error: string }> }>;
```

- [ ] **Step 1: Write failing adapter tests**

Assert exact per-feature patches, default concurrency `2`, monotonic progress, independent failures, result ordering, and retry behavior when the caller passes only failed assignments. Also assert HTTP client serialization includes candidate `providerId`, `thinkingLevel`, and `reasoningEffort`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run apps/ui/tests/unit/lib/bulk-model-assignment.test.ts`

Expected: FAIL because the adapter and client method do not exist.

- [ ] **Step 3: Implement the typed client and adapter**

Use `toFeatureModelPatch` for every update and a two-worker index queue. Convert thrown values to user-safe one-line messages and retain the original assignment order in success/failure results.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npx vitest run apps/ui/tests/unit/lib/bulk-model-assignment.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the application adapter**

```powershell
git add apps/ui/src/lib/http-api-client.ts apps/ui/src/components/views/board-view/shared/bulk-model-assignment.ts apps/ui/tests/unit/lib/bulk-model-assignment.test.ts
git commit -m "[feat] add recoverable bulk model assignment"
```

### Task 5: Balance Models Dialog

**Files:**

- Create: `apps/ui/src/components/views/board-view/dialogs/balance-models-dialog.tsx`
- Test: `apps/ui/tests/unit/components/balance-models-dialog.test.tsx`

**Interfaces:**

- Consumes catalog/distribution/client/adapter from Tasks 1-4.
- Produces:

```ts
interface BalanceModelsDialogProps {
  open: boolean;
  projectPath: string;
  features: Feature[];
  onOpenChange: (open: boolean) => void;
  onUpdateFeature: (featureId: string, patch: Partial<Feature>) => Promise<void>;
  onComplete: (result: { succeededIds: string[]; failedIds: string[] }) => void;
}
```

- [ ] **Step 1: Write failing component tests**

Test that Automatic is default; candidates are one-per-provider; Manual supports multiple checkboxes; `Apply Distribution` is disabled until verification; accessible Pending/Verifying/Verified/Unavailable text is present; automatic failures are excluded and rebalanced; manual failures block Apply until removed/retried; changing mode or candidates clears verification/preview; preview counts and feature names match the pure engine; no update is called before Apply; partial saves list failed feature names and `Retry Failed` updates only those assignments.

- [ ] **Step 2: Run the component test and confirm RED**

Run: `npx vitest run apps/ui/tests/unit/components/balance-models-dialog.test.tsx`

Expected: FAIL because the dialog does not exist.

- [ ] **Step 3: Implement the compact accessible dialog**

Use the existing dialog primitives and AboardAI dark/orange visual tokens. Render radio controls named `Distribution mode`, manual model checkboxes named with provider/model labels, a `Verify Models` button, text-backed status badges, a count summary, a disclosure for per-feature assignments, and save progress. Snapshot `features` when `open` changes from false to true. In automatic mode build the pool from only verified candidates; in manual mode require every current selection to have a verified result. Clear verification whenever mode or selection changes.

- [ ] **Step 4: Run the component test and confirm GREEN**

Run: `npx vitest run apps/ui/tests/unit/components/balance-models-dialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the dialog**

```powershell
git add apps/ui/src/components/views/board-view/dialogs/balance-models-dialog.tsx apps/ui/tests/unit/components/balance-models-dialog.test.tsx
git commit -m "[feat] add verified model distribution dialog"
```

### Task 6: Backlog Selection Integration

**Files:**

- Modify: `apps/ui/src/components/views/board-view/components/selection-action-bar.tsx`
- Modify: `apps/ui/src/components/views/board-view.tsx`
- Modify: `apps/ui/tests/unit/components/selection-action-bar.test.tsx`
- Create: `apps/ui/tests/unit/components/board-view-model-distribution.test.tsx`

**Interfaces:**

- `SelectionActionBar` adds `onBalanceModels: () => void` and renders the action alongside existing `Enhance Selected` and `Edit Selected` controls.
- `BoardView` passes only board-ordered backlog features whose IDs are selected to `BalanceModelsDialog`.

- [ ] **Step 1: Write failing action-bar and board tests**

Assert the action has accessible name `Balance Models`, calls `onBalanceModels`, and does not remove existing actions. In the board test select a mixed-status fixture and assert the dialog receives only selected backlog features in board order. Assert full completion clears selection and partial completion leaves only failed IDs selected.

- [ ] **Step 2: Run focused integration tests and confirm RED**

Run: `npx vitest run apps/ui/tests/unit/components/selection-action-bar.test.tsx apps/ui/tests/unit/components/board-view-model-distribution.test.tsx`

Expected: FAIL because the prop/action/dialog integration does not exist.

- [ ] **Step 3: Wire the board workflow**

Add local dialog state, derive the ordered snapshot from the backlog column, and call the existing feature-update API/query invalidation path through `onUpdateFeature`. On success close the dialog and selection mode. On partial failure keep selection mode active with exactly `failedIds`. Do not alter Mass Edit, per-feature Edit, Enhance Selected, or Make behavior.

- [ ] **Step 4: Run focused integration tests and confirm GREEN**

Run: `npx vitest run apps/ui/tests/unit/components/selection-action-bar.test.tsx apps/ui/tests/unit/components/board-view-model-distribution.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the board integration**

```powershell
git add apps/ui/src/components/views/board-view/components/selection-action-bar.tsx apps/ui/src/components/views/board-view.tsx apps/ui/tests/unit/components/selection-action-bar.test.tsx apps/ui/tests/unit/components/board-view-model-distribution.test.tsx
git commit -m "[feat] expose model balancing for backlog selections"
```

### Task 7: Regression, Browser, and Build Verification

**Files:**

- Create: `apps/ui/e2e/balance-models.spec.ts`
- Modify only if failures reveal a scoped defect in files from Tasks 1-6.

**Interfaces:**

- Browser test intercepts `POST **/api/models/verify-access` and feature update requests; it never reaches a live provider or persists real feature changes.

- [ ] **Step 1: Write the browser smoke test**

Cover a selected subset and Select All. Stub automatic verification success, a manual multi-model set, one unavailable manual model, partial feature-update failure, and successful retry. Assert stable preview counts after closing/reopening with the same inputs and confirm the existing Mass Edit model picker remains available.

- [ ] **Step 2: Run the browser test and fix only observed scoped failures**

Run: `npx playwright test apps/ui/e2e/balance-models.spec.ts --project=chromium`

Expected: PASS with intercepted network calls and no subscription consumption.

- [ ] **Step 3: Run focused and full automated verification**

Run:

```powershell
npx vitest run apps/ui/tests/unit/lib/model-distribution.test.ts apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/lib/bulk-model-assignment.test.ts apps/ui/tests/unit/components/balance-models-dialog.test.tsx apps/ui/tests/unit/components/selection-action-bar.test.tsx apps/ui/tests/unit/components/board-view-model-distribution.test.tsx
npx vitest run --project=server apps/server/tests/unit/services/model-access-verifier.test.ts apps/server/tests/unit/routes/models/verify-access.test.ts
npm run test:all
npm run lint:errors
npm run lint:server:errors
npm run typecheck
npm run build
npm run build:server
```

Expected: all commands exit `0`. If an unrelated baseline failure appears, record it separately and prove the focused suites still pass.

- [ ] **Step 4: Review the final diff and repository boundary**

Run:

```powershell
git status --short
git diff --check
git diff HEAD -- apps/ui apps/server libs/types docs/superpowers
```

Confirm the known unrelated untracked artifacts remain unstaged and unchanged: `CLAUDE-FABLE-5.md`, `apps/ui/test/`, `create-group-dialog.png`, `dashboard-crash.png`, and `graphify-out/`.

- [ ] **Step 5: Commit browser coverage or final scoped fixes**

```powershell
git add apps/ui/e2e/balance-models.spec.ts
git commit -m "[test] cover verified model distribution workflow"
```

- [ ] **Step 6: Stop before pushing**

Report the commits and verified commands. Do not push until the user explicitly requests it; at that point run the repository identity gate and obtain confirmation for the exact remote and branch.
