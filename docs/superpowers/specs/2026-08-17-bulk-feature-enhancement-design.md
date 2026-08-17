# Bulk Feature Enhancement Design

## Goal

Let users apply any existing **Enhance with AI** action to all selected backlog features in the current worktree or branch. Selecting all backlog features must make the workflow a practical one-action bulk operation.

## Product behavior

- Add **Enhance Selected** to the existing backlog selection action bar.
- Reuse the current five modes without changing their labels, prompts, examples, or rewrite-versus-append behavior.
- Reuse the enhancement model selection and optional model override.
- After confirmation, enhance and save each selected feature automatically.
- Show completed, total, and failed counts while the batch runs.
- Prevent duplicate submissions while processing.
- Keep successfully enhanced features saved if another feature fails. At completion, report failures clearly and allow failed features to be retried.
- Limit the operation to selected backlog features in the current worktree or branch. The existing **Select All** action supplies the one-click all-features scope.

## Architecture

The UI orchestrates a concurrency-limited queue. Each feature goes through the same `/api/enhance-prompt` request used by the single-feature editor, followed by that feature's normal update request. This keeps the established prompt construction and provider behavior as the single source of truth and avoids a long-running monolithic server request.

Shared client-side enhancement-result handling will preserve the current behavior: rewrite modes replace the description, while additive modes retain the original description and append generated content.

## Failure handling

Failures are isolated per feature. The progress dialog remains visible during processing and ends with a success/partial-failure summary. Successful updates are refreshed on the board. Failed feature IDs remain selected for a direct retry; a completely successful batch exits selection mode.

Closing the progress dialog while processing is disabled so the user cannot accidentally obscure an active batch. No destructive rollback is attempted because completed AI calls and saved feature updates are individually valid.

## Verification

- Unit-test mode selection and rewrite-versus-append composition.
- Component-test the action bar entry, confirmation, progress, success, partial failure, and retry state.
- Verify the existing single-feature enhancer still uses identical prompts and behavior.
- Run focused UI tests, TypeScript/build checks, and a browser smoke test against the local application.
