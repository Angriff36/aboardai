# Contributing to AboardAI

Thanks for contributing to AboardAI. This guide reflects the current `Angriff36/aboardai` repository and its `main`-based workflow.

By submitting a contribution, you agree that it may be distributed under the repository’s [MIT License](LICENSE). Contributions derived from upstream work must retain applicable copyright and license notices.

## Before you start

Use Node.js `>=22.0.0 <23.0.0`, npm, and Git. A provider account is needed only for tests or manual flows that perform real agent execution; the automated suite supports `ABOARDAI_MOCK_AGENT=true`.

Fork [Angriff36/aboardai](https://github.com/Angriff36/aboardai), then clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/aboardai.git
cd aboardai
git remote add upstream https://github.com/Angriff36/aboardai.git
npm install
```

Confirm the remotes before pushing:

```bash
git remote -v
```

`origin` should be your fork and `upstream` should be the AboardAI repository.

## Development commands

```bash
npm run dev                 # Interactive launcher
npm run dev:web             # Browser UI on localhost:47821
npm run dev:electron        # Electron application
npm run dev:electron:debug  # Electron with DevTools
npm run dev:server          # Backend on localhost:47820

npm run build               # Shared packages + browser UI
npm run build:packages      # Shared packages only
npm run build:server        # Shared packages + server
npm run build:electron      # Desktop package for the current platform

npm run test                # Playwright E2E tests
npm run test:headed         # Playwright with a visible browser
npm run test:packages       # Shared-package Vitest projects
npm run test:server         # Server Vitest project
npm run test:all            # All Vitest projects
npm run typecheck           # UI TypeScript check
npm run lint                # UI ESLint
npm run format:check        # Prettier verification
```

Run a focused server test with:

```bash
npm run test:server -- tests/unit/specific.test.ts
```

The full Playwright suite uses ports `3107` and `3108` by default and enables the mock agent. Set `TEST_PORT` or `TEST_SERVER_PORT` if those ports are unavailable.

## Repository structure

```text
apps/ui/       React, Vite, Electron, and Playwright
apps/server/   Express, WebSocket, providers, services, and Vitest tests
libs/          Shared @aboardai/* packages
docs/          Current technical guides plus clearly named historical plans/research
```

Shared packages follow this dependency direction:

```text
@aboardai/types
  -> utils, prompts, platform, model-resolver, dependency-resolver, spec-parser
  -> git-utils
  -> server and ui
```

Import shared behavior from `@aboardai/*`; do not recreate old server-local copies of shared types or utilities.

## Branches and pull requests

Create a focused branch from the current upstream `main`:

```bash
git fetch upstream
git switch -c feature/short-description upstream/main
```

The current workflows run on pull requests to any branch and on pushes to `main` or `master`. There is no standing RC-branch requirement in the checked-in workflows.

Keep commits small and descriptive. Existing history commonly uses bracketed types such as:

```text
[feature] add provider capability probe
[fix] preserve session metadata during rename
[docs] document current Docker authentication
[refactor] share worktree path validation
```

Before opening a pull request, run the gates relevant to your change. For most code changes, start with:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:all
npm run build
```

Run Playwright when the behavior crosses a user flow, and run the Electron or server build when your change affects that target. If an unrelated baseline failure prevents a full gate, identify the failing command and explain why it is unrelated.

A pull request should explain:

- What changed and why.
- Which behavior or issue it addresses.
- Which commands were run and their results.
- Any provider, platform, migration, or security implications.
- Screenshots or recordings for visible UI changes.

Target the AboardAI repository and the appropriate current base branch, normally `main`.

## Code and test expectations

- Use TypeScript and existing project patterns.
- Keep the package dependency direction intact.
- Preserve the HTTP/WebSocket event model between the server and UI.
- Use `@aboardai/platform` and the server’s path-validation helpers for filesystem access.
- Add tests for bug fixes and externally visible behavior.
- Keep real provider calls out of automated tests; use mocks and fixtures.
- Do not commit credentials, generated release artifacts, local data, or project-specific `.aboardai/` contents unless a fixture explicitly requires them.

Formatting is enforced with Prettier, and staged supported files may be formatted by the repository’s hooks.

## Provider changes

Built-in providers live in `apps/server/src/providers/` and register through `provider-factory.ts`. Provider changes should preserve normalized `ProviderMessage` events, abort handling, authentication detection, and model routing. Update [docs/server/providers.md](docs/server/providers.md) when the provider contract or supported integrations change.

Claude-compatible endpoint configuration is separate from built-in provider adapters. See [docs/UNIFIED_API_KEY_PROFILES.md](docs/UNIFIED_API_KEY_PROFILES.md).

## Reporting issues and security problems

Use the [AboardAI issue tracker](https://github.com/Angriff36/aboardai/issues) for reproducible bugs and feature proposals. Include the operating system, Node version, run mode, provider, relevant logs with secrets removed, and minimal reproduction steps.

Do not post credentials, OAuth tokens, private source, or exploit details in a public issue. If no private reporting channel is published by the repository, open a minimal issue asking the maintainer for a private contact path without disclosing sensitive details.

Upstream Automaker communities and unrelated Discord servers are not AboardAI support channels.
