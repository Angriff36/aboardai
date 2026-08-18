# Normal Electron Update Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each AboardAI desktop release visibly versioned and eliminate the second PWA-style update after installation.

**Architecture:** A pure renderer policy function will allow service workers only in browser/PWA mode. A pure Electron cleanup helper will clear only service-worker registrations and Cache Storage for the packaged localhost renderer before its first window loads. The Electron package version will advance to `1.1.0` so the installer and in-app version are unambiguous.

**Tech Stack:** Electron 39, React/Vite, TypeScript, Vitest, electron-builder/NSIS

## Global Constraints

- Preserve cookies, local storage, IndexedDB, settings, credentials, and project data.
- Keep browser/PWA service-worker behavior unchanged.
- Produce `AboardAI-1.1.0-x64.exe`.

---

### Task 1: Web-only service-worker policy

**Files:**

- Create: `apps/ui/src/lib/service-worker-policy.ts`
- Modify: `apps/ui/src/renderer.tsx`
- Test: `apps/ui/tests/unit/lib/service-worker-policy.test.ts`

**Interfaces:**

- Produces: `shouldRegisterServiceWorker(environment): boolean`

- [ ] Write tests proving browser HTTP registers while Electron, `file:`, and unsupported environments do not.
- [ ] Run the focused test and verify it fails because the policy module is absent.
- [ ] Implement the pure policy and use the preload bridge as the Electron signal in `renderer.tsx`.
- [ ] Run the focused test and verify it passes.

### Task 2: Remove stale Electron PWA state before window load

**Files:**

- Create: `apps/ui/src/electron/utils/clear-web-update-state.ts`
- Modify: `apps/ui/src/main.ts`
- Test: `apps/ui/tests/unit/electron/clear-web-update-state.test.ts`

**Interfaces:**

- Produces: `clearWebUpdateState(storageSession, origin): Promise<void>`

- [ ] Write a test requiring `clearStorageData` to receive the localhost origin and only `serviceworkers` plus `cachestorage`.
- [ ] Run the focused test and verify it fails because the helper is absent.
- [ ] Implement the helper and await it after the packaged static server starts but before `createWindow()`.
- [ ] Run the focused test and verify it passes.

### Task 3: Version and package the release

**Files:**

- Modify: `apps/ui/package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces: Electron app version `1.1.0` and installer `AboardAI-1.1.0-x64.exe`.

- [ ] Update only the UI workspace package version and corresponding lockfile workspace entry to `1.1.0`.
- [ ] Run UI typechecking, focused tests, all package tests, and all server tests.
- [ ] Build Electron and verify the installer filename, embedded app version, size, timestamp, and SHA-256.
- [ ] Commit the implementation and verification-ready release metadata.
