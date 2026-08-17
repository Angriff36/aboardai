# Live Model Catalog and Provider Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live provider discovery authoritative, expose current Cursor models automatically, and replace the flat balancing list with collapsible globally enabled provider groups.

**Architecture:** Keep provider-specific discovery in existing query/provider adapters and make the shared feature-model catalog synchronize discovered IDs wherever it is consumed. Return provider groups alongside the flat enabled candidate list, then render those groups in the balancing dialog with persistent built-in/custom-provider toggles.

**Tech Stack:** TypeScript, React 19, Zustand, TanStack Query, Radix UI, Vitest, Testing Library, Electron Builder.

## Global Constraints

- Live discovery is authoritative when a provider exposes it; static catalogs are fallback only.
- New discovered model IDs are enabled automatically while explicitly excluded known IDs stay excluded.
- Provider disablement is global and persistent.
- Disabled providers are not verified or assigned.
- Existing manual per-feature selection remains available.
- Tests must not consume provider credits or mutate real feature data.

---

### Task 1: Authoritative Cursor discovery

**Files:**

- Modify: `apps/ui/src/hooks/queries/use-models.ts`
- Modify: `apps/ui/src/components/views/board-view/shared/model-constants.ts`
- Modify: `apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts`
- Test: `apps/ui/tests/unit/lib/model-constants.test.ts`
- Test: `apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx`

**Interfaces:**

- Consumes: `useCursorModels(refresh?: boolean)` and `syncCursorModelsDiscovery(models)`.
- Produces: a catalog in which a non-empty live Cursor inventory supersedes static fallback models and newly discovered IDs synchronize from any catalog consumer.

- [ ] **Step 1: Write failing discovery tests**

Add assertions using literal live definitions:

```ts
const live = [
  { id: 'cursor-composer-2.5', name: 'Composer 2.5', provider: 'cursor' },
  {
    id: 'cursor-grok-4.6-high-fast',
    name: 'Cursor Grok 4.6 Fast',
    provider: 'cursor',
  },
];

expect(
  getAvailableCursorModels(
    live.map((model) => model.id),
    live
  )
).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ id: 'cursor-composer-2.5' }),
    expect.objectContaining({ id: 'cursor-grok-4.6-high-fast' }),
  ])
);
expect(
  getAvailableCursorModels(
    live.map((model) => model.id),
    live
  )
).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cursor-composer-1' })]));
```

In the hook test, mock `useCursorModels()` with the same live definitions and assert `syncCursorModelsDiscovery(live)` is called without mounting Cursor Settings.

- [ ] **Step 2: Run tests and confirm the expected failures**

Run:

```powershell
npx vitest run --project=ui apps/ui/tests/unit/lib/model-constants.test.ts apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx
```

Expected: static Composer 1 remains in the live result and discovery synchronization is absent.

- [ ] **Step 3: Implement the minimal discovery changes**

Set `refetchOnMount: refresh ? 'always' : true` in `useCursorModels`. Call it as `useCursorModels(true)` from the shared catalog. Add a catalog effect:

```ts
useEffect(() => {
  if (cursorQuery.data?.length) {
    void syncCursorModelsDiscovery(cursorQuery.data);
  }
}, [cursorQuery.data, syncCursorModelsDiscovery]);
```

In `getAvailableCursorModels`, map the live definitions as the complete source whenever `dynamicModels.length > 0`; use `CURSOR_MODELS` only when discovery returned no usable data. Apply the existing enabled-ID preference filter to the chosen source.

- [ ] **Step 4: Run the focused tests until green**

Run the Task 1 Vitest command and require all assertions to pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/ui/src/hooks/queries/use-models.ts apps/ui/src/components/views/board-view/shared/model-constants.ts apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts apps/ui/tests/unit/lib/model-constants.test.ts apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx
git commit -m "[fix] make live Cursor discovery authoritative"
```

### Task 2: Persistent provider-group catalog

**Files:**

- Modify: `apps/ui/src/store/types/state-types.ts`
- Modify: `apps/ui/src/store/app-store.ts`
- Modify: `apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts`
- Test: `apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx`
- Test: `apps/ui/tests/unit/store/app-store-provider-visibility.test.ts`

**Interfaces:**

- Produces:

```ts
export interface FeatureModelProviderGroup {
  key: string;
  label: string;
  enabled: boolean;
  candidates: ModelAssignmentCandidate[];
  builtInProvider?: ModelProvider;
  customProviderId?: string;
  refreshable?: boolean;
}

setProviderEnabled(groupKey: string, enabled: boolean): Promise<void>;
```

- [ ] **Step 1: Write failing grouping and persistence tests**

Assert that enabled and disabled built-in/custom providers are returned as groups, but only enabled group candidates appear in the flat `candidates` list. Assert that disabling a built-in provider calls `settings.updateGlobal({ disabledProviders: [...] })`; assert that disabling an OpenRouter-compatible profile calls its existing provider update action with `{ enabled: false }`.

- [ ] **Step 2: Run tests and confirm failures**

Run:

```powershell
npx vitest run --project=ui apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/store/app-store-provider-visibility.test.ts
```

Expected: `groups` and persistent built-in toggling do not exist.

- [ ] **Step 3: Implement provider groups and persistence**

Build candidates into group-local arrays first, including disabled provider inventories. Return the flattened candidates from enabled groups only. Implement `setProviderEnabled` by routing built-ins through `toggleProviderDisabled` and compatible profiles through `updateClaudeCompatibleProvider`.

Make `toggleProviderDisabled` asynchronous and persist the deduplicated next array:

```ts
toggleProviderDisabled: async (provider, disabled) => {
  const next = disabled
    ? [...new Set([...get().disabledProviders, provider])]
    : get().disabledProviders.filter((item) => item !== provider);
  set({ disabledProviders: next });
  await getHttpApiClient().settings.updateGlobal({ disabledProviders: next });
},
```

Log persistence failures using the existing store logger without reverting the responsive local state.

- [ ] **Step 4: Run focused tests until green**

Run the Task 2 Vitest command and require all assertions to pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/ui/src/store/types/state-types.ts apps/ui/src/store/app-store.ts apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx apps/ui/tests/unit/store/app-store-provider-visibility.test.ts
git commit -m "[feat] persist grouped provider visibility"
```

### Task 3: Collapsible balancing UI

**Files:**

- Create: `apps/ui/src/components/views/board-view/dialogs/provider-model-group.tsx`
- Modify: `apps/ui/src/components/views/board-view/dialogs/balance-models-dialog.tsx`
- Test: `apps/ui/tests/unit/components/balance-models-dialog.test.tsx`

**Interfaces:**

- Consumes: `FeatureModelProviderGroup[]`, `setProviderEnabled`, current selection, and verification results.
- Produces: accessible collapsible provider headers with a persistent provider switch and provider-scoped model rows.

- [ ] **Step 1: Write failing UI tests**

Mock Cursor, Codex, and an OpenRouter-compatible group. Assert that model rows are hidden until their provider header is expanded, toggling OpenRouter calls `setProviderEnabled('claude-compatible:openrouter', false)`, and disabled OpenRouter candidates never reach `verifyAccess`.

- [ ] **Step 2: Run the component test and confirm failure**

```powershell
npx vitest run --project=ui apps/ui/tests/unit/components/balance-models-dialog.test.tsx
```

Expected: the current flat list has no provider group buttons or switches.

- [ ] **Step 3: Implement the grouped UI**

Use the existing Radix `Collapsible` and `Switch` components. Each header exposes `aria-expanded`, provider label, enabled model count, and a switch named `Use <provider>`. Keep the first enabled group expanded when the dialog opens. Manual mode renders provider-scoped checkboxes; automatic mode renders only each provider's preferred candidate. Provider toggles invalidate verification before changing the catalog.

- [ ] **Step 4: Run component and distribution tests**

```powershell
npx vitest run --project=ui apps/ui/tests/unit/components/balance-models-dialog.test.tsx apps/ui/tests/unit/lib/model-distribution.test.ts
```

Expected: all tests pass with stable automatic/manual assignments.

- [ ] **Step 5: Commit**

```powershell
git add apps/ui/src/components/views/board-view/dialogs/provider-model-group.tsx apps/ui/src/components/views/board-view/dialogs/balance-models-dialog.tsx apps/ui/tests/unit/components/balance-models-dialog.test.tsx
git commit -m "[feat] group balancing models by provider"
```

### Task 4: Shared picker provider organization

**Files:**

- Modify: `apps/ui/src/components/views/settings-view/model-defaults/phase-model-selector.tsx`
- Test: `apps/ui/tests/unit/components/phase-model-selector.test.tsx`

**Interfaces:**

- Consumes: the same live provider groups and enablement actions from the shared catalog.
- Produces: collapsible provider sections in the existing per-feature/default picker without changing selection callbacks or model execution metadata.

- [ ] **Step 1: Write failing picker tests**

Assert that current live Cursor IDs are searchable under Cursor, provider model rows are collapsed by default, the selected provider starts expanded, and disabling a provider removes its models while preserving the selected value until the user chooses another model.

- [ ] **Step 2: Run the picker test and confirm failure**

```powershell
npx vitest run --project=ui apps/ui/tests/unit/components/phase-model-selector.test.tsx
```

- [ ] **Step 3: Replace flat provider command groups with collapsible provider sections**

Reuse the group ordering and labels from `useFeatureModelCatalog`. Preserve the existing `onChange({ model, providerId, thinkingLevel, reasoningEffort })` calls and favorites behavior. Do not alter provider execution or default-selection semantics.

- [ ] **Step 4: Run the picker and catalog tests until green**

```powershell
npx vitest run --project=ui apps/ui/tests/unit/components/phase-model-selector.test.tsx apps/ui/tests/unit/hooks/use-feature-model-catalog.test.tsx
```

- [ ] **Step 5: Commit**

```powershell
git add apps/ui/src/components/views/settings-view/model-defaults/phase-model-selector.tsx apps/ui/tests/unit/components/phase-model-selector.test.tsx
git commit -m "[feat] group shared model picker providers"
```

### Task 5: End-to-end verification and Electron installer

**Files:**

- Modify only if verification exposes an in-scope defect.

**Interfaces:**

- Verifies the complete user workflow without live model execution or feature writes.

- [ ] **Step 1: Run focused and full automated checks**

```powershell
npm run test:all
npm run lint:errors
npm run lint:server:errors
npm run typecheck
npm run build:server
```

- [ ] **Step 2: Run browser smoke verification**

Start the web UI on an unused port. Intercept access verification and feature update calls. Confirm live Cursor discovery shows Composer 2.5 and Cursor Grok 4.6, provider sections collapse, OpenRouter can be disabled without scrolling through its models, and disabled providers are absent from verification payloads.

- [ ] **Step 3: Build and verify the Windows installer**

```powershell
npm run build:electron:win
Get-Item apps/ui/release/AboardAI-1.0.0-x64.exe | Format-List FullName,Length,LastWriteTime
Get-FileHash apps/ui/release/AboardAI-1.0.0-x64.exe -Algorithm SHA256
```

Require build exit code 0 and a current installer timestamp.

- [ ] **Step 4: Save continuity state and commit any verification-only fix**

Record the completed behavior and verification evidence in the project session bridge. If a verification defect required code changes, repeat its focused red-green test and commit only that fix.
