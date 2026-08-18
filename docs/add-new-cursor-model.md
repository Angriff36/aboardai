# Cursor model discovery and fallback catalog

AboardAI normally discovers the current Cursor model catalog from the installed Cursor agent CLI. Adding a newly released Cursor model usually requires no source change.

## Current model flow

1. `CursorProvider` locates `cursor-agent` or a supported `cursor agent` command.
2. `apps/server/src/providers/cursor-model-discovery.ts` runs the CLI with `--list-models`.
3. The server parses the returned slugs into `ModelDefinition` values and caches the result for five minutes.
4. `useFeatureModelCatalog()` fetches that inventory for the shared model selectors.
5. `getAvailableCursorModels()` treats a non-empty live inventory as authoritative.
6. If discovery returns no usable models, the UI and provider fall back to `CURSOR_MODEL_MAP` in `libs/types/src/cursor-models.ts`.

Enabled-model settings filter whichever inventory is active. They do not make the static fallback map authoritative over a successful live discovery.

## When no code change is needed

If `cursor-agent --list-models` reports the new model, refresh **Settings → Providers → Cursor** or restart AboardAI and verify that the model appears in the picker. Do not add the model to the static map solely to mirror a live catalog entry.

Use the exact CLI-reported slug. AboardAI converts it to the canonical `cursor-<slug>` form for routing and persistence.

## Updating the offline fallback

Update `libs/types/src/cursor-models.ts` only when AboardAI should recognize the model without successful CLI discovery, needs known capability metadata, or needs a deliberate grouped-variant presentation.

For a standalone fallback model:

1. Add its canonical `cursor-` ID to `CursorModelId`.
2. Add a matching entry to `CURSOR_MODEL_MAP` with label, description, thinking flag, and vision flag supported by the current adapter.
3. Add it to `STANDALONE_CURSOR_MODELS`, or place it in the appropriate `CURSOR_MODEL_GROUPS` entry when it is a real variant of another model.
4. Add a legacy mapping only when an already-persisted old ID must migrate.

Do not guess capability flags from a marketing name. Verify what the Cursor CLI and `CursorProvider` actually pass through.

## Verification

Check parser and definition behavior with focused server tests, then run the shared gates:

```bash
npm run build:packages
npm run test:packages
npm run test:server
npm run typecheck
```

For a live smoke test:

1. Run the installed Cursor agent’s model-list command and save only non-sensitive output.
2. Open the feature model picker and confirm the same current inventory appears.
3. Confirm disabling a Cursor model filters it from the picker.
4. Simulate failed discovery and confirm the static fallback remains usable.
5. Verify an actual execution only when suitable provider credentials and quota are available.

Provider routing remains in `apps/server/src/providers/provider-factory.ts`; model UI assembly remains in `apps/ui/src/components/views/board-view/shared/model-constants.ts` and `apps/ui/src/components/views/settings-view/model-defaults/use-feature-model-catalog.ts`.
