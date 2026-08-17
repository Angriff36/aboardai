# Lessons

## 2026-06-12 — "Leave me running" requires a pending wake-up source

**Mistake:** Ended the Phase 2 turn implying autonomous continuation ("or just leave me running"), but with zero pending background tasks nothing re-invokes the orchestrator — it idled all night.
**Rule:** When the user grants standing autonomy across phases, NEVER end a turn with the next phase unstarted. Either (a) keep working in the current turn, (b) leave a background agent running whose completion re-invokes me, or (c) explicitly schedule a wakeup (ScheduleWakeup) before ending the turn. State plainly what will happen if I stop.

## 2026-06-15 — Put features where the user actually works, not where the code is convenient

Correction: I placed the "Import Doc" entry point in the Spec Editor (App Specification view)
because that view already had the spec→features plumbing. User had no idea what that view was
and (correctly) expected task-creation features on the Kanban Board. The Spec Editor also only
renders once a spec exists, so a fresh project couldn't reach it at all.
Rule:

- Entry points belong where the OUTPUT lives. Import produces board tasks → button goes on the
  BOARD header (next to Plan), not on a spec/settings screen.
- "Reuses existing plumbing there" is an implementation convenience, NOT a UX justification.
- Verify the screen is reachable in the relevant state (no hidden dependency like "spec must
  exist first").
- After a UI change, remember the running app is the OLD build until dev server restarts/HMR —
  tell the user to restart, or they'll think the change didn't ship.

## 2026-06-15 — Adding an export to a barrel (index.ts) breaks the running Vite dev server

Symptom: app launched but spun forever / never rendered; DevTools showed
"The requested module '.../board-view/dialogs/index.ts' does not provide an export
named 'ImportDocumentDialog'". Production `vite build` passed; export WAS on disk.
Cause: I added `ImportDocumentDialog` to the board-view dialogs barrel and imported it
THROUGH the barrel. The running dev server had a stale `.vite` module graph for that
barrel, so the importer saw a version without the new export → board route crashed on
import → blank/spinner. Terminal logs looked fine (200s) because it's a renderer-side
ESM error, invisible in the node console.
Rules:

- For NEW cross-feature/heavy components, import DIRECTLY from the file, not via a barrel
  index.ts. (board-view already imported several dialogs directly — follow that pattern.)
- After adding/removing exports in a barrel that's already in a running dev graph, clear
  `apps/ui/node_modules/.vite` (or run vite with --force) so the graph rebuilds.
- A clean `vite build` does NOT prove dev works — dev uses native ESM + a separate cache.
- A blank/spinning Electron renderer with healthy backend 200s = look in the RENDERER
  DevTools console (Vite ESM/overlay errors), not the terminal.
