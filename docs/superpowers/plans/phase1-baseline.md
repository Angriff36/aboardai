# Phase 1 Baseline — Stock automaker on Windows

**Date:** 2026-06-11
**Branch:** main (commit d192a10 import, stock automaker source pre-rename)
**Platform:** Windows 11 Home 10.0.26200
**Shell:** git-bash
**Node:** v22.18.0 (matches engines: >=22.0.0 <23.0.0)
**npm:** 10.9.3

---

## Step 2.1 — npm install

**Result:** SUCCESS

- 1179 packages added (1190 audited)
- postinstall ran: fix-lockfile-urls.mjs rewrote git+ssh:// URLs in package-lock.json
- prepare ran: husky + build:packages (all 8 libs compiled cleanly)
- 37 vulnerabilities (2 low, 6 moderate, 26 high, 3 critical) — pre-existing, not blocking
- Deprecation warnings only (inflight, glob, rimraf, boolean, @npmcli/move-file) — not blocking

---

## Step 2.2 — Build

**Result:** SUCCESS

`npm run build:packages` — all 8 libs compiled via tsc with zero errors:

- @automaker/types
- @automaker/platform
- @automaker/utils
- @automaker/spec-parser
- @automaker/prompts
- @automaker/model-resolver
- @automaker/dependency-resolver
- @automaker/git-utils

`npm run build` — includes apps/ui Vite build:

- 3651 modules transformed (client)
- 56 modules transformed (electron main)
- 3 modules transformed (electron preload)
- Built in ~8.3s
- Only chunk-size warnings (vendor-codemirror 1053 kB, vendor-xterm 728 kB) — not errors

---

## Step 2.3 — Unit Tests

**Summary:** 2 test files failed | 135 passed | 1 skipped (138 total files)
6 tests failed | 3413 passed | 28 skipped (3447 total tests)
**Duration:** ~27.65s

### Failing Test Files

#### 1. apps/server — tests/unit/services/execution-service.test.ts

- 87 tests total, 1 failed
- **Test:** `executeFeature - agent output validation > reads agent output from the correct path with utf-8 encoding`
- **Error:** Windows path-separator mismatch — test expects forward-slash path `/test/project/.automaker/features/feature-1/agent-output.md` but received backslash path `\test\project\.automaker\features\feature-1\agent-output.md`
- **Root cause:** Windows-specific pre-existing issue; path normalization not done for win32

#### 2. apps/server — tests/unit/routes/worktree/list-detached-head.test.ts

- 5 tests failed
- **Tests:**
  - `porcelain parser > should include worktrees with detached HEAD and recover branch from rebase-merge state` — expected branch "feature/rebasing", received "(detached)"
  - `porcelain parser > should include worktrees with detached HEAD and recover branch from rebase-apply state` — expected branch "feature/rebasing", received "(detached)"
  - `porcelain parser > should handle mixed normal and detached worktrees` — expected branch "feature/rebasing", received "(detached)"
  - `porcelain parser > should strip refs/heads/ prefix from recovered branch name` — expected "my-branch", received "(detached)"
  - `scanWorktreesDirectory with detached HEAD recovery > should recover branch for discovered worktrees with detached HEAD` — expected worktree to be defined, was undefined
- **Root cause:** Detached HEAD branch recovery logic incomplete; worktree parser not reading rebase-merge/rebase-apply state files

### Per-Workspace Breakdown

| Workspace           | Files    | Tests Passed | Tests Failed | Tests Skipped |
| ------------------- | -------- | ------------ | ------------ | ------------- |
| dependency-resolver | 1        | 49           | 0            | 0             |
| platform            | 5        | 74           | 0            | 0             |
| utils               | ~several | passing      | 0            | 0             |
| spec-parser         | ~several | passing      | 0            | 0             |
| prompts             | ~several | passing      | 0            | 0             |
| model-resolver      | ~several | passing      | 0            | 0             |
| dependency-resolver | 1        | 49           | 0            | 0             |
| git-utils           | ~several | passing      | 0            | 0             |
| server              | 2 failed | ~3200+       | 6            | ~20+          |
| ui (vitest)         | passing  | passing      | 0            | ~8            |

Note: Both failing files are in the `server` project. All lib workspaces and apps/ui vitest suite are green.

---

## Step 2.4 — E2E Tests (Playwright)

**Playwright version:** from apps/ui/node_modules
**Browser:** Chromium (installed via `npx playwright install chromium`)
**Test ports:** 3107 (UI/Vite dev), 3108 (Express server)
**Mock agent:** enabled (AUTOMAKER_MOCK_AGENT=true, hardcoded in playwright.config.ts)
**Workers:** 8 (local mode)

**Summary:** 52 failed | 2 skipped | 20 passed out of 74 tests in 25 spec files
**Duration:** ~3.8 minutes

Note: Totals vary by ±2 between runs due to race conditions/flakiness in parallel workers.

### Passing Spec Files (25 total — 7 spec files fully passed)

- `tests/features/add-feature-to-backlog.spec.ts` — passed
- `tests/features/feature-skip-tests-toggle.spec.ts` — passed
- `tests/features/list-view-priority.spec.ts` — passed
- `tests/features/running-task-card-display.spec.ts` — partial (1 fail noted in some runs)
- `tests/profiles/profiles-crud.spec.ts` — passed
- `tests/settings/settings-startup-sync-race.spec.ts` — partial
- `tests/utils/project/fixtures.spec.ts` — 14 passed, 1 failed

### Failing Tests by Spec File

#### tests/agent/start-new-chat-session.spec.ts

1. `should start a new agent chat session` — TimeoutError: locator.waitFor 10000ms exceeded (UI element not appearing)

#### tests/context/add-context-image.spec.ts

2. `should import an image file to context` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/context/context-file-management.spec.ts

3. `should create a new markdown context file` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/context/delete-context-file.spec.ts

4. `should delete a context file via the UI` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/context/desktop-context-view.spec.ts

5. `should show file list and editor side-by-side on desktop` — TimeoutError: 15000ms exceeded
6. `should NOT show back button in editor toolbar on desktop` — TimeoutError: 15000ms exceeded
7. `should show buttons with text labels on desktop` — TimeoutError: 15000ms exceeded
8. `should show delete button in toolbar on desktop` — TimeoutError: 15000ms exceeded (cascade: context APIRequestContext.post timed out)
9. `should show file list at fixed width on desktop when file is selected` — TimeoutError: 15000ms exceeded
10. `should show action buttons inline in header on desktop` — TimeoutError: 15000ms exceeded

#### tests/features/edit-feature.spec.ts

11. `should edit an existing feature description` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/features/feature-deep-link.spec.ts

12. `should open output modal when navigating to /board?featureId=xxx` — TimeoutError: APIRequestContext.get auth/status timeout 5000ms (backend not ready or race)
13. `should handle invalid featureId gracefully` — assertion: expect(received).toBe(expected) equality
14. `should handle navigation without featureId` — assertion: expect(received).toBe(expected) equality

#### tests/features/feature-manual-review-flow.spec.ts

15. `should manually verify a feature in waiting_approval column` — Error: page.waitForResponse Test timeout 30000ms; route.fetch: Target page/context/browser closed

#### tests/features/opus-thinking-level-none.spec.ts

16. `persists thinkingLevel none when selected for Claude Opus` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/features/planning-mode-fix-verification.spec.ts

17. `planning mode selector should be enabled and accessible in add feature dialog` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/features/responsive/agent-output-modal-responsive.spec.ts

18. `Mobile View (< 640px) > should use full width on mobile screens` — TimeoutError
19. `Mobile View (< 640px) > should have proper max width constraint on mobile` — TimeoutError
20. `Small View (640px-768px) > should use 60vw on small screens` — TimeoutError
21. `Small View (640px-768px) > should have 80vh max height on small screens` — TimeoutError
22. `Tablet View (>= 768px) > should use 90vw on tablet screens` — TimeoutError
23. `Tablet View (>= 768px) > should have 1200px max width on tablet` — TimeoutError
24. `Tablet View (>= 768px) > should have 85vh max height on tablet screens` — TimeoutError
25. `Tablet View (>= 768px) > should maintain correct height on larger tablets` — TimeoutError
26. `Responsive Transitions > should update modal size when resizing from mobile to tablet` — TimeoutError
27. `Responsive Transitions > should update modal size when resizing from tablet to mobile` — TimeoutError
28. `Content Responsiveness > should display content correctly on tablet view` — TimeoutError
29. `Content Responsiveness > should maintain readability on tablet with wider width` — TimeoutError
30. `Modal Functionality > should maintain functionality while resizing` — TimeoutError
31. `Modal Functionality > should handle view mode buttons on tablet` — TimeoutError

#### tests/features/running-task-card-display.spec.ts (varies by run)

32. `should show Logs/Stop buttons for in_progress features, not Make button` — TimeoutError (seen in some runs)

#### tests/features/success-log-contrast.spec.ts

33. `should display success log output with improved contrast` — TimeoutError: locator.waitFor 15000ms exceeded
34. `should maintain consistency across all log types` — TimeoutError
35. `should have consistent badge styling with improved contrast` — TimeoutError

#### tests/memory/desktop-memory-view.spec.ts

36. `shows file list and editor side-by-side with desktop toolbar` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/projects/board-background-persistence.spec.ts

37. `should load board background settings when switching projects` — TimeoutError (cascade: APIRequestContext.post 15000ms; page.goto ERR_ABORTED)
38. `should load background settings on app restart` — TimeoutError

#### tests/projects/new-project-creation.spec.ts

39. `should create a new blank project from welcome view` — TimeoutError: locator.waitFor 15000ms exceeded

#### tests/projects/open-existing-project.spec.ts

40. `should open an existing project directory from recent projects` — TimeoutError

#### tests/projects/overview-dashboard.spec.ts

41. `should navigate to overview from sidebar and display overview UI` — TimeoutError
42. `should display aggregate statistics cards` — TimeoutError
43. `should display project status cards` — TimeoutError
44. `should navigate to board when clicking on a project card` — TimeoutError
45. `should display empty state when no projects exist` — TimeoutError
46. `should show error state when API fails` — TimeoutError

#### tests/settings/event-hooks-settings.spec.ts

47. `should load event hooks settings section without errors` — TimeoutError: locator.waitFor 10000ms exceeded
48. `should open add ntfy endpoint dialog and verify useEffect resets form` — TimeoutError
49. `should open and close endpoint dialog without JavaScript errors` — TimeoutError
50. `should have enabled toggle working in endpoint dialog` — TimeoutError
51. `should have Add Endpoint button disabled when form is invalid` — TimeoutError
52. `should persist ntfy endpoint after adding and page reload` — TimeoutError
53. `should display existing endpoints on initial load` — TimeoutError

#### tests/settings/settings-startup-sync-race.spec.ts (varies by run)

54. `does not overwrite projects when /api/settings/global is temporarily unavailable` — TimeoutError (seen in some runs)

#### tests/utils/project/fixtures.spec.ts

55. `should handle Windows-style path traversal attempt ..\ (platform-dependent)` — AssertionError: `memoryFileExistsOnDisk` threw on Windows when test expected it not to throw; backslash path traversal treated differently on Windows filesystem

### Skipped Tests (2)

- `tests/features/feature-skip-tests-toggle.spec.ts` — 1 test skipped (condition-gated)
- (One other test marked skip)

---

## Environment Quirks / Concerns

1. **Windows path separator in unit tests:** `execution-service.test.ts` fails because the code path uses OS-native backslashes but the test hardcodes forward slashes. Pre-existing Windows compatibility gap — not related to rename.

2. **Detached HEAD worktree recovery not implemented:** `list-detached-head.test.ts` has 5 failures testing a feature that parses rebase-merge/rebase-apply state files to recover branch names. Logic is absent from the implementation.

3. **E2E flakiness pattern — dominant failure is TimeoutError:** The majority (~80%) of E2E failures are locator.waitFor or APIRequestContext timeouts. The app loads (sidebar, navigation visible per error snapshots), but specific UI elements fail to appear within 10-15s. Possible causes: Windows I/O slower than Linux test baselines; mock agent response timing; 8-worker parallelism on a single Windows machine causing port/process contention.

4. **E2E cascade failures:** Several tests fail with "Target page/context/browser has been closed" — these are secondary failures caused by a prior test exhausting resources or timing out while holding state.

5. **fixtures.spec.ts Windows-specific failure:** Test `should handle Windows-style path traversal attempt ..\` is explicitly marked "platform-dependent" in the test title. On Windows, the backslash path IS interpreted as directory traversal, causing the function to throw. This is a known platform gap in the fixture utility's path sanitization, confirmed as a Windows-only behavior difference.

6. **package-lock.json drift:** The postinstall script (`fix-lockfile-urls.mjs`) rewrites git+ssh:// URLs in package-lock.json on every install. This means package-lock.json may differ from the checked-in version after install on Windows.

7. **Audit vulnerabilities:** 37 npm audit vulnerabilities present in stock code. Not blocking but should be tracked.

---

## Files Baseline Covers

- `package-lock.json` (potentially modified by fix-lockfile-urls postinstall hook)
- `docs/superpowers/plans/phase1-baseline.md` (this file)
