# Balanced Model Distribution Design

## Goal

Let a user redistribute all selected backlog features across a balanced set of AI models backed by working, active provider subscriptions. The workflow must verify real access to every model before any feature assignments are saved.

This is a purely optional bulk action. Existing single-feature model selection, Mass Edit model selection, model defaults, and automatic execution behavior remain unchanged.

## Scope

### Included

- A new `Balance Models` action in backlog selection mode.
- Support for any selected subset and the existing `Select All` backlog action.
- Automatic selection of one strong configured model from each usable provider/subscription.
- Manual selection of one or more models from the existing feature model catalog.
- A real, minimal access probe for every model that may receive features.
- A preview of the exact model-to-feature assignment before saving.
- Even, deterministic distribution across verified models.
- Progress, partial-save failure reporting, and retry for feature updates.

### Excluded

- Running, waiting-approval, verified, completed, or archived features.
- Background or implicit redistribution.
- Changes to existing per-feature or Mass Edit model controls.
- Provider setup, subscription purchasing, authentication, or login flows.
- Cost optimization, benchmark-based model ranking, or semantic task-to-model matching.
- Starting feature implementation after assignments are saved.

## User Experience

### Entry point

The backlog selection action bar gains a `Balance Models` button. It is enabled only when at least one backlog feature is selected. The existing `Select All` action remains the way to target the entire backlog.

Opening the action launches a focused dialog without modifying feature data.

### Step 1: Choose distribution mode

The dialog offers two modes:

1. **Automatic** — AboardAI builds a candidate set containing one preferred implementation-capable model from each configured provider/subscription. Provider defaults and the existing enabled-model configuration determine the representative model; the workflow does not enable disabled providers or models.
2. **Manual** — The user can select any number of models from the same enabled model catalog used by current feature model selectors. Existing provider/model labels and model-specific thinking or reasoning controls are preserved.

Automatic is the default. Switching modes has no effect outside the dialog.

### Step 2: Verify access

The dialog requires an explicit `Verify Models` action before generating the final spread. Verification sends a minimal, read-only, no-tools request through the exact provider, model, provider profile, thinking level, and reasoning effort that would be assigned.

Each candidate shows one of four states:

- Pending
- Verifying
- Verified
- Unavailable, with the returned provider error

Installation, configuration, or cached model discovery is not sufficient proof of access. A model is eligible only after its exact probe succeeds during the current dialog session.

Automatic behavior:

- Unavailable candidates are removed from the assignment pool.
- The remaining verified candidates are rebalanced automatically.
- If no candidate verifies, preview and apply remain blocked.

Manual behavior:

- Every manually selected model must verify.
- A failed model remains visible so the user can retry or remove it.
- Preview and apply remain blocked while any selected model is unverified.

Changing the mode or model selection invalidates the previous verification result and requires verification again.

### Step 3: Preview the spread

After verification, the dialog shows:

- The number of selected features.
- Each verified provider and model.
- The number of features assigned to each model.
- An expandable per-feature assignment list.

The distribution is deterministic round-robin in the selected features' existing board order and the displayed model order. Assignment counts differ by at most one. Reopening and applying the same inputs produces the same result.

The preview is the final confirmation boundary. No feature data changes before the user clicks `Apply Distribution`.

### Step 4: Apply

Each feature is updated independently with the assigned:

- `model`
- `providerId`, when applicable
- `thinkingLevel`, when applicable
- `reasoningEffort`, when applicable

Fields that do not apply to the assigned model are cleared so stale provider-specific settings cannot leak into execution.

The dialog shows save progress. Successful updates remain saved. Failed updates are listed by feature name and can be retried without resaving successful features. Full success closes selection mode; partial success keeps only failed features selected.

## Model Catalog and Automatic Candidate Rules

The workflow reuses the existing enabled feature-model inventory rather than introducing a second source of truth. Candidates may come from Claude Code, Cursor, Codex, OpenCode-connected providers, Gemini, Copilot, and configured Claude-compatible providers when they already appear as enabled choices in the feature model selector.

Automatic mode groups candidates by actual execution provider/subscription and selects one representative per group:

1. The provider's configured default model, if it is enabled and implementation-capable.
2. Otherwise the first enabled model in the provider's existing display order.

This prevents a provider exposing many model variants from receiving a disproportionate share. Manual mode has no one-model-per-provider restriction.

## Architecture

### Shared model catalog

Extract the model inventory construction currently embedded in the feature model selector into a reusable hook or focused module. Both the existing selector and the new dialog consume the same normalized entries, labels, provider identities, and capability metadata.

A normalized assignment candidate contains:

- Stable candidate key
- Model ID
- Display name
- Execution provider
- Optional `providerId`
- Optional thinking level
- Optional reasoning effort
- Whether it is the configured provider default

### Pure distribution engine

A UI-independent module accepts ordered feature IDs and ordered verified candidates and returns deterministic assignments plus per-model counts. It rejects empty feature or candidate inputs and never mutates its arguments.

### Access-verification API

Add a provider-agnostic models endpoint that accepts the project path and normalized candidate entries. The server:

1. Validates the project path and request size.
2. Resolves each exact model and optional Claude-compatible provider profile using existing settings/model resolution.
3. Runs bounded probes with read-only mode, no tools, one turn, and a timeout.
4. Returns an independent result for every candidate rather than failing the whole batch.
5. Limits verification concurrency to avoid spawning every CLI simultaneously.

The endpoint must not expose tokens, credential paths, raw provider payloads, or sensitive environment details in its response.

### Bulk feature update adapter

The board composes the preview assignments into existing feature update calls. A focused adapter owns progress tracking, partial failures, and retry IDs, following the established bulk enhancement pattern.

## Error Handling

- Model discovery failure: show the provider/model inventory error and keep Apply disabled.
- Verification timeout: mark only that candidate unavailable and allow retry.
- Authentication, billing, subscription, or rate-limit failure: surface a concise provider error without treating it as verified access.
- Selection changed while dialog is open: retain the original batch snapshot for the active operation, matching bulk enhancement behavior.
- Feature update failure: keep successful assignments and allow retry for failed features only.
- Dialog closed before apply: discard verification and preview state; no data changes.
- Fewer verified models than selected features: continue balanced round-robin reuse.
- More verified models than selected features: only the first models in stable display order receive one feature; the preview shows zero-count verified models separately or omits them from the assignment summary while retaining their verified status.

## Accessibility and Visual Design

The dialog follows AboardAI's existing dark, compact, orange-accent visual language. Provider icons, compact verification status badges, a count-based distribution summary, and an expandable assignment list make the workflow scannable without introducing a new visual system.

All mode controls, model toggles, verification results, progress, and apply states must be keyboard accessible and have explicit accessible names. Status must not rely on color alone.

## Testing

### Unit tests

- Stable round-robin distribution.
- Count difference never exceeds one.
- Manual model ordering is preserved.
- Empty inputs are rejected.
- Automatic candidate grouping chooses at most one representative per provider.
- Changing candidates invalidates verification state.
- Failed automatic candidates are excluded and remaining assignments rebalance.
- Manual failures block preview/apply.
- Model-specific fields are set or cleared correctly.
- Partial feature-update failures retry only failed IDs.

### Server tests

- Exact model and provider profile are passed to the probe.
- Probes are read-only, no-tools, one-turn, bounded, and concurrency-limited.
- Results are isolated per candidate.
- Authentication, billing, rate-limit, timeout, and generic provider failures remain unverified.
- Invalid project paths, empty candidate sets, oversized batches, and malformed model entries are rejected.
- Mock-agent mode provides deterministic verification without external spend.

### Component tests

- Button appears only for backlog selection.
- Automatic mode is default and manual mode supports multi-selection.
- Apply is disabled before verification.
- Verification status and errors are named accessibly.
- Preview counts and assignments match the distribution engine.
- Changing mode/models requires re-verification.
- Partial saves preserve successful work and expose retry.
- Existing Enhance Selected and Edit Selected actions remain available.

### Browser verification

Exercise selected-subset and Select All flows with intercepted verification and update responses. Verify automatic success, manual multi-model selection, one failed model, partial update failure, retry, stable preview counts, and preservation of existing manual model-edit controls. No live subscription credits or real feature files are consumed during the browser smoke test.

## Success Criteria

- A user can distribute selected or all backlog features across multiple subscriptions without editing tasks individually.
- Automatic mode uses only models that pass a real access probe during the workflow.
- Manual mode permits any number of enabled models and cannot apply until every selection verifies.
- Assignment counts are balanced and deterministic.
- No feature changes occur before preview confirmation.
- Existing manual selection behavior remains unchanged.
- Partial failures are recoverable without repeating successful updates.
