# Feature: Import Tasks from a Document

Generalize AboardAI so any structured document (audit register, IMPLEMENTATION_PLAN.md,
PRD, checklist, design doc) can be broken down by AI into customizable board tasks
(features) and run by the existing auto-mode engine with its proven system prompts.

## Why this is small

The extraction -> parse -> create -> auto-run pipeline already exists for
`generate-features-from-spec`. This feature reuses ALL of it and only changes the
INPUT SOURCE (a user-provided document instead of `.aboardai/app_spec.txt`) plus a
prompt tuned to "extract existing work items and normalize ordering into dependencies".

## Architecture

document (pasted text OR file path) -> importFeaturesFromDocument()
-> buildImportPrompt() [pure, tested]
-> streamingQuery() (reuse model resolution + structured output)
-> parseAndCreateFeatures() [REUSED verbatim -> features land in backlog]
-> emits `spec_regeneration_complete` -> global invalidation refreshes board

## Plan / checklist

### Backend

- [x] Map the existing spec->features pipeline
- [ ] `libs/prompts/src/defaults.ts`: add `DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT`
- [ ] `libs/prompts/src/index.ts`: export the new constant
- [ ] `apps/server/src/routes/app-spec/common.ts`: add `'document_import'` to GenerationType
- [ ] `apps/server/src/routes/app-spec/import-from-document.ts`: new module - pure exported `buildImportPrompt(...)` - `importFeaturesFromDocument(...)` reusing model resolution + `parseAndCreateFeatures`
- [ ] `apps/server/src/routes/app-spec/routes/import-document.ts`: POST handler
      (body `{ projectPath, documentText?, documentPath?, maxFeatures? }`)
- [ ] `apps/server/src/routes/app-spec/index.ts`: register `POST /import-document`

### Frontend

- [ ] `electron.ts` + `types/electron.d.ts`: add `importDocument` to SpecRegenerationAPI
- [ ] `http-api-client.ts`: add `specRegeneration.importDocument(...)`
- [ ] `use-spec-mutations.ts` + mutations `index.ts`: `useImportDocument`
- [ ] `spec-view/dialogs/import-document-dialog.tsx`: paste textarea + max tasks + submit
- [ ] Wire entry point into spec-view header

### Verification

- [ ] Unit tests: `buildImportPrompt` + `resolveDocumentContent`
- [ ] `npm run build:packages` (prompts) green
- [ ] `npm run test:server` green

## Notes / decisions

- Import prompt kept as a standalone exported constant (centralized + testable) rather
  than expanding the full prompt-customization type surface — minimal impact.
- Reuse `spec-regeneration:event` so existing progress/notification/board invalidation
  works with zero new wiring.
- Document accepted as pasted TEXT (no path security concerns) OR a file path read via
  secureFs (respects ALLOWED_ROOT_DIRECTORY).

## Review — COMPLETE

All checklist items implemented and verified.

### What shipped

Backend

- `libs/prompts/src/defaults.ts` + `index.ts`: `DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT`
  (format-agnostic extraction + dependency normalization), exported.
- `apps/server/src/routes/app-spec/import-from-document.ts`: new module. Pure exported
  helpers `buildImportPrompt`, `buildExistingFeaturesContext`, `appendPlainJsonInstructions`;
  `importFeaturesFromDocument()` reuses model resolution + structured output + the existing
  `parseAndCreateFeatures` persistence (features land in `backlog`, ready for auto-mode).
- `routes/import-document.ts`: `POST /import-document` with testable `resolveDocumentContent`
  (inline text OR secureFs path read; 400 on bad input; background fire-and-forget).
- Registered in `index.ts`; `common.ts` GenerationType gains `'document_import'`.

Frontend

- API: `specRegeneration.importDocument` in http-api-client + both electron type files +
  mock API implementation.
- `useImportDocument` mutation (+ export).
- `import-document-dialog.tsx`: self-contained paste-and-import dialog; reuses the shared
  `spec-regeneration:event` stream (board auto-refreshes via existing global invalidation
  on `spec_regeneration_complete`).
- Entry point: "Import Doc" button in spec-view header (desktop + mobile) + dialog mount.

### Verification

- `npm run build:packages` — green
- New unit tests: 16/16 pass (`import-from-document.test.ts`)
- Full server suite: 2733 pass / 28 skipped / 0 fail
- `tsc --noEmit` server + UI — both clean (also fixed a pre-existing null-assignability
  error in `cursor-model-discovery.ts`)
- ESLint touched files — 0 errors; Prettier formatted

### Follow-ups (not blocking, out of scope)

- Expose an "Import Doc" entry on the empty-state (no-spec) screen and/or board header so a
  project with no AboardAI spec can import without generating a spec first.
- Optional: promote the import prompt to a customizable prompt in Settings → Prompts.
- Optional: classifier to flag tasks the document marks as upstream/external so auto-mode
  doesn't attempt them unattended.
