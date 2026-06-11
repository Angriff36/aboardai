# Phase 1: Fork & Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import automaker's source into this repo, rebrand it to AboardAI everywhere, and prove the stock app builds, tests green, and runs on Windows — establishing the baseline for Phases 2–5.

**Architecture:** Mechanical migration, not feature work. The safety net is automaker's inherited test suite plus a strict ordering: prove the *stock* fork builds/tests on Windows BEFORE renaming, so Windows breakage and rename breakage can never be confused. The rename is done by one deterministic script (full code below), never by freehand agent edits.

**Tech Stack:** npm workspaces monorepo, TypeScript, Express 5 + ws (apps/server, port 3008), React 19 + Vite + Electron 39 (apps/ui, port 3007), Vitest, Playwright (test ports 3107/3108). Node v22.18.0 confirmed installed.

**Spec:** `docs/superpowers/specs/2026-06-11-aboardai-v1-design.md`

---

## Established facts (measured 2026-06-11, do not re-derive)

- Source: `C:\Projects\referencerepos\automaker`, git HEAD = `5888d2e6f3618e06762803687ea7b181c10edcbd` (2026-05-22), origin `https://github.com/AutoMaker-Org/automaker.git`, MIT (LICENSE has a "no longer maintained" disclaimer above the MIT text; copyright line: `Copyright (c) 2025 Automaker Core Contributors`).
- Brand occurrences (excl. node_modules/.git/dist): `automaker` 1,408 in 250 files; `Automaker` 406 in 104 files; `AutoMaker` 85 in 46 files; `AUTOMAKER` 189 in 35 files; plus 42 in package-lock.json.
- 10 workspace packages: root `automaker`, `@automaker/{types,utils,platform,prompts,model-resolver,dependency-resolver,git-utils,spec-parser}` in `libs/*`, `@automaker/server` in `apps/server`, `@automaker/ui` in `apps/ui`.
- Brand-named files: `start-automaker.mjs`, `start-automaker.sh`, `apps/ui/public/automaker.svg`, `apps/ui/src/components/layout/sidebar/components/automaker-logo.tsx`, `apps/ui/src/components/views/settings-view/components/remove-from-automaker-dialog.tsx`, `apps/server/tests/unit/lib/automaker-paths.test.ts`.
- Electron config in `apps/ui/package.json`: `appId: com.automaker.app`, `productName: Automaker`, Linux `executableName: automaker`, `desktopName: automaker.desktop`. PWA manifest `apps/ui/public/manifest.json` references `Automaker` and `/automaker.svg`.
- Per-project data dir `.automaker` defined in `libs/platform/src/paths.ts` (`getAutomakerDir`); referenced from ~134 files. Global data: `DATA_DIR` env, default `./data`.
- 38 env vars prefixed `AUTOMAKER_` (notably `AUTOMAKER_MOCK_AGENT`, used by Playwright config).
- Ports stay the same: 3007 UI / 3008 server / 3107+3108 test (defined in `libs/types/src/ports.ts`).
- Tests: 26 Playwright spec files (15 reference the brand string), config at `apps/ui/playwright.config.ts`; Vitest configs at root, both apps, and all 8 libs.
- 23 GitHub URL references to `AutoMaker-Org/automaker` (package.json homepage/repository, UI bug-report links, CONTRIBUTING.md, docs/install-fedora.md).
- This repo (`C:\Projects\aboardai`) currently contains ONLY `CLAUDE.md` (CogniLayer-managed — its CogniLayer block must survive) and `docs/` (the spec + this plan). Git history: 2 doc commits on `main`.

## Brand mapping (canonical — use everywhere)

| From | To | Applies to |
|---|---|---|
| `@automaker/` | `@aboardai/` | package names, imports |
| `AUTOMAKER` | `ABOARDAI` | env vars, constants |
| `AutoMaker` | `AboardAI` | display strings, identifiers |
| `Automaker` | `AboardAI` | display strings, identifiers |
| `automaker` | `aboardai` | everything else: ids, paths, `.automaker`→`.aboardai`, `com.automaker.app`→`com.aboardai.app`, filenames, GitHub org/repo→`Angriff36/aboardai` |

Display name is **AboardAI** (not "Aboardai"). Identifiers like `getAutomakerDir` become `getAboardAIDir` — accept the mechanical result; do not hand-tune casing.

**Never renamed (exclusions):** `LICENSE` (keeps Automaker Core Contributors copyright), `NOTICE` (attribution), `docs/superpowers/**` (specs/plans legitimately discuss automaker), `tasks/**`, `.git/**`, `node_modules/**`.

---

### Task 1: Import automaker source (raw, no rename)

**Files:** Create: entire automaker tree at repo root. Special handling: automaker's `CLAUDE.md` lands as `CLAUDE.automaker.md.tmp` (merged in Task 7); automaker's `docs/*` merges into existing `docs/`.

- [ ] **Step 1.1: Export tracked files from automaker's git (clean — no node_modules/.git) into a temp dir**

```bash
mkdir -p /c/Projects/aboardai/.import-tmp
git -C /c/Projects/referencerepos/automaker archive 5888d2e6f3618e06762803687ea7b181c10edcbd | tar -x -C /c/Projects/aboardai/.import-tmp
```

- [ ] **Step 1.2: Verify no docs/ filename collisions, then move into place**

```bash
cd /c/Projects/aboardai
# collision check — expect NO output:
for f in $(cd .import-tmp/docs && find . -type f); do [ -e "docs/$f" ] && echo "COLLISION: docs/$f"; done
mv .import-tmp/CLAUDE.md CLAUDE.automaker.md.tmp
cp -r .import-tmp/docs/. docs/ && rm -rf .import-tmp/docs
cp -r .import-tmp/. . && rm -rf .import-tmp
```

Expected: repo root now has `apps/`, `libs/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, `start-automaker.mjs`, etc. Our `CLAUDE.md` is UNCHANGED (verify: `grep -c COGNILAYER CLAUDE.md` ≥ 1).

- [ ] **Step 1.3: Verify file count sanity and commit**

```bash
git -C /c/Projects/referencerepos/automaker ls-tree -r 5888d2e --name-only | wc -l   # expect N
cd /c/Projects/aboardai && git add -A && git status --short | wc -l                  # expect ~N (+tmp file, − merged docs already counted)
git commit -m "[fork] import automaker @ 5888d2e (MIT) as AboardAI foundation"
```

### Task 2: Baseline proof on Windows (stock, PRE-rename)

Purpose: per spec risk #1, prove the stock fork runs on Windows before any rename, so later failures are attributable.

- [ ] **Step 2.1: Install** — `npm install` (expect success; node-pty prebuilds for win32 must resolve). If it fails: STOP, this is a Windows-compat issue to fix before anything else.
- [ ] **Step 2.2: Build** — `npm run build:packages && npm run build` (expect green).
- [ ] **Step 2.3: Unit tests** — `npx vitest run` from root (root vitest.config.ts orchestrates; if it doesn't cover workspaces, run `npm test --workspaces --if-present`). Record pass/fail counts.
- [ ] **Step 2.4: E2E baseline** — `cd apps/ui && npx playwright install chromium` then run the E2E suite per `apps/ui/playwright.config.ts` (mock agent mode is set by the config via `AUTOMAKER_MOCK_AGENT`). Record exact pass/fail/skip counts and names of failing specs into `docs/superpowers/plans/phase1-baseline.md`. DO NOT fix stock failures now — they are the baseline; triage at end of phase (Task 9).
- [ ] **Step 2.5: Commit** — `git add -A && git commit -m "[chore] lockfile/baseline artifacts from stock Windows install"` (only if files changed).

### Task 3: Rename brand-named files (git mv)

- [ ] **Step 3.1:**

```bash
cd /c/Projects/aboardai
git mv start-automaker.mjs start-aboardai.mjs
git mv start-automaker.sh start-aboardai.sh
git mv apps/ui/public/automaker.svg apps/ui/public/aboardai.svg
git mv apps/ui/src/components/layout/sidebar/components/automaker-logo.tsx apps/ui/src/components/layout/sidebar/components/aboardai-logo.tsx
git mv apps/ui/src/components/views/settings-view/components/remove-from-automaker-dialog.tsx apps/ui/src/components/views/settings-view/components/remove-from-aboardai-dialog.tsx
git mv apps/server/tests/unit/lib/automaker-paths.test.ts apps/server/tests/unit/lib/aboardai-paths.test.ts
git ls-files | grep -i automaker   # expect EMPTY
git commit -m "[rename] brand-named files automaker -> aboardai"
```

### Task 4: Content rename sweep (deterministic script)

**Files:** Create then delete `rename-brand.mjs` at repo root. Modifies ~250 source files + package-lock.json.

- [ ] **Step 4.1: Write `rename-brand.mjs` with EXACTLY this content**

```js
// One-shot brand rename: automaker -> aboardai. Run from repo root. Deleted after use.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const EXCLUDE = [/^docs\/superpowers\//, /^tasks\//, /^LICENSE$/, /^NOTICE$/, /^CLAUDE\.automaker\.md\.tmp$/, /^rename-brand\.mjs$/];
const REPLACEMENTS = [
  ['@automaker/', '@aboardai/'],
  ['AUTOMAKER', 'ABOARDAI'],
  ['AutoMaker', 'AboardAI'],
  ['Automaker', 'AboardAI'],
  ['automaker', 'aboardai'],
];
const NUL = String.fromCharCode(0);
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter(f => !EXCLUDE.some(rx => rx.test(f)));
let changed = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes(NUL)) continue; // skip binary files
  let out = text;
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  if (out !== text) { writeFileSync(f, out); changed++; }
}
console.log(`rewrote ${changed} files`);
```

- [ ] **Step 4.2: Run it** — `node rename-brand.mjs` (expect "rewrote ~250+ files" — package-lock.json included).
- [ ] **Step 4.3: Gate check** — `git grep -iI automaker -- ':!docs/superpowers' ':!tasks' ':!LICENSE' ':!NOTICE' ':!CLAUDE.automaker.md.tmp'` → expect EMPTY. If anything remains, fix the script's exclusion/ordering, NOT the files by hand, then re-run.
- [ ] **Step 4.4: Delete script, commit** — `rm rename-brand.mjs && git add -A && git commit -m "[rename] content sweep automaker -> aboardai (script-driven, ~250 files)"`.

### Task 5: Post-rename reinstall + rebuild + unit tests

- [ ] **Step 5.1:** `rm -rf node_modules && npm install` (clean reinstall regenerates `node_modules/@aboardai/*` workspace links; lockfile was renamed by Task 4 — npm must accept it without drift. If npm rewrites the lockfile, inspect the diff: only name fields should change, no version changes).
- [ ] **Step 5.2:** `npm run build:packages && npm run build` — expect green. Build errors here are rename-caused by definition (Task 2 proved stock green); typical causes: missed identifier, casing edge (`AboardAIDir`), import path. Fix root cause in source.
- [ ] **Step 5.3:** `npx vitest run` — pass count must equal Task 2.3 baseline.
- [ ] **Step 5.4:** Commit — `git add -A && git commit -m "[fix] post-rename build/test corrections"` (or `[chore] lockfile after rename` if no fixes needed).

### Task 6: E2E suite post-rename

- [ ] **Step 6.1:** Run the same Playwright suite as Task 2.4 (env vars are now `ABOARDAI_MOCK_AGENT` etc. — the config file was renamed by the sweep, so it is self-consistent).
- [ ] **Step 6.2:** Compare to baseline in `phase1-baseline.md`. Requirement: every spec that passed at baseline still passes. New failures = rename regressions (likely suspects: localStorage persistence keys, asset paths `/automaker.svg`, window-title assertions). Fix and re-run until parity.
- [ ] **Step 6.3:** Commit fixes — `git commit -m "[fix] E2E parity after rename"`.

### Task 7: Identity & attribution files

**Files:** Modify `LICENSE`; Create `NOTICE`; Modify `CLAUDE.md`, `README.md`, root `package.json`; Delete `CLAUDE.automaker.md.tmp`.

- [ ] **Step 7.1: LICENSE** — remove the "Project Status" disclaimer block (lines 1–5); keep MIT text; copyright becomes two lines:

```
Copyright (c) 2026 AboardAI contributors
Copyright (c) 2025 Automaker Core Contributors
```

- [ ] **Step 7.2: NOTICE (new file)**

```
AboardAI is a fork of automaker (https://github.com/AutoMaker-Org/automaker),
imported at commit 5888d2e6f3618e06762803687ea7b181c10edcbd (2026-05-22), MIT License,
Copyright (c) 2025 Automaker Core Contributors.

Design ideas (no code) adapted from:
- vibe-kanban (https://github.com/BloopAI/vibe-kanban, Apache-2.0): provider adapter
  pattern, log normalization, worktree race-safety.
- OpenHands (MIT) and ai-agent-board (MIT): availability probing, task-group patterns.
```

- [ ] **Step 7.3: CLAUDE.md merge** — take `CLAUDE.automaker.md.tmp`, apply the brand mapping to its text manually (it was excluded from the sweep), then place that content ABOVE the existing CogniLayer block in `CLAUDE.md`. The CogniLayer block (`# === COGNILAYER` … `# === END COGNILAYER ===`) must survive byte-identical. Delete the tmp file (`git rm CLAUDE.automaker.md.tmp` — use plain `rm` if it was never tracked).
- [ ] **Step 7.4: Root package.json** — verify `"name": "aboardai"` (sweep did it), set `"version": "0.1.0"`, `"repository": "https://github.com/Angriff36/aboardai"`. Same repository/homepage/bugs fields in `apps/ui/package.json`.
- [ ] **Step 7.5: README.md** — replace the top title/intro with a short AboardAI description + one-line fork attribution linking to NOTICE. Body cleanup is Phase 5; just ensure nothing contradicts the new brand.
- [ ] **Step 7.6: Commit** — `git commit -m "[docs] LICENSE/NOTICE attribution, CLAUDE.md merge, package identity"`.

### Task 8: Dev-run proof on Windows

- [ ] **Step 8.1:** Start the server: `npm run dev:server` in background; poll `http://localhost:3008/api/health` (or the root endpoint if no /health — check `apps/server/src/index.ts` for the actual route) until 200, max 120s.
- [ ] **Step 8.2:** Start the web UI: `npm run _dev:web` in background; `curl -s http://localhost:3007 | grep -i aboardai` → expect match (title/manifest).
- [ ] **Step 8.3:** Kill ONLY these processes: `npx kill-port 3007 3008`. NEVER `taskkill //F //IM node.exe`.
- [ ] **Step 8.4:** Electron launch (`npm run dev:electron`) is best-effort: try once; if it opens (or logs a successful window create), note it; if it fails, file the error in `phase1-baseline.md` as a known issue — NOT a phase blocker (web mode is the v1 daily driver).
- [ ] **Step 8.5:** Commit any fixes.

### Task 9: Phase gate

- [ ] **Step 9.1:** Full gate from root: `npm run lint` (if defined; else per-workspace) + typecheck (`npm run typecheck` or `tsc -b` per workspace as the repo defines) + `npx vitest run` + `npm run build` — ALL green.
- [ ] **Step 9.2:** Re-run the zero-reference gate from Task 4.3 — EMPTY.
- [ ] **Step 9.3:** Baseline-failure triage: for each E2E/unit failure recorded in Task 2 that is still failing, either fix it now (if < ~30 min each) or document it in `phase1-baseline.md` with a root-cause hypothesis as Phase 5 backlog.
- [ ] **Step 9.4:** Update `tasks/todo.md` with a review section: what was done, counts, deviations. Final commit `[phase1] fork & rebrand complete — gate green`.

---

## Execution notes for the orchestrator

- Work happens directly on `main` — this phase *creates* the codebase; there is nothing to isolate from. Phases 2+ use branches/worktrees.
- Model assignment: Tasks 1, 3, 4 → Haiku (mechanical, exact commands given). Tasks 2, 5, 6, 8, 9 → Sonnet (build/test debugging judgment). Task 7 → Haiku.
- One subagent per task, fresh context, report back: commands run, outputs, counts, deviations. Orchestrator reviews between tasks and owns deviation decisions.
- Long operations: `npm install` ~minutes; full Playwright suite possibly 10–30 min — run with adequate Bash timeouts (600000 ms) and never kill blindly.
