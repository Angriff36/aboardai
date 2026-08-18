# Normal Electron Update Flow

## Problem

Local Electron releases all report `1.0.0` and overwrite the same installer filename. The packaged app also loads its renderer from `http://localhost`, so the web/PWA service worker mistakenly runs inside Electron. After installing a new binary, that stale service worker can prompt for a second renderer update and reload.

## Design

- Release this work as AboardAI `1.1.0`, producing `AboardAI-1.1.0-x64.exe` and displaying `v1.1.0` in the app.
- Keep PWA service-worker updates in browser mode only. Detect the Electron preload bridge before registering the service worker.
- Before the packaged Electron window loads, clear only `serviceworkers` and `cachestorage` for the local renderer origin. Preserve cookies, local storage, IndexedDB, settings, credentials, and project data.
- Keep the current NSIS install-over-existing-app behavior. The user closes AboardAI, runs one clearly versioned installer, and launches the installed shortcut once.

## Verification

- Unit-test the browser-versus-Electron registration policy.
- Unit-test that Electron cleanup targets only the local origin and the two web-cache storage types.
- Run UI typechecking, focused tests, the full package/server suites, and a production Electron build.
- Confirm the resulting filename, embedded version, size, timestamp, and SHA-256.
