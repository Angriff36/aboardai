# Orchestrated Feature Execution Implementation Plan

**Goal:** Add optional, server-enforced lead/workhorse/cross-provider-reviewer execution with a five-round revision loop while preserving current single-model behavior.

**Architecture:** Persist a normalized orchestration configuration on each feature, select and verify role assignments from the live model catalog, and run a dedicated orchestration service from the existing execution path. The orchestration service owns artifact persistence and the approval state machine. UI controls reuse provider-grouped model catalog components and existing bulk assignment behavior.

**Tech Stack:** TypeScript, React 19, Express 5, Vitest, Testing Library, Playwright, Electron.

## Tasks

### 1. Shared contracts and validation

- Add orchestration configuration, role assignment, phase, verdict, and run-record types to `@aboardai/types`.
- Add pure validation helpers for cross-provider reviewer separation and round limits.
- Write failing unit tests first, then implement minimal contracts/helpers.

### 2. Automatic role selection

- Extend normalized model candidates with orchestration capability/ranking metadata derived from live catalog entries.
- Implement deterministic lead/workhorse/reviewer selection without exact version allowlists.
- Require lead/reviewer provider diversity and prefer workhorse diversity.
- Write ranking, newest-version, disabled-provider, and insufficient-provider tests first.

### 3. Server orchestration state machine

- Add artifact storage helpers under each feature's `orchestration/` directory.
- Add an orchestration service that verifies assignments, runs lead planning, delegates implementation, runs the existing pipeline, performs read-only structured review, and loops through lead revision plus workhorse repair.
- Cap review at five rounds.
- Make reviewer approval the only orchestration path to `verified`; otherwise preserve work in `waiting_approval`.
- Add focused service tests covering call order, approval, rejection, malformed review, provider loss, cancellation, and round exhaustion.

### 4. Execution integration

- Route orchestrated features through the new service from `ExecutionService`/Auto Mode while leaving single-model features untouched.
- Allow agent invocations to accept an exact role assignment and read-only/tool restrictions.
- Reuse provider resolution and access verification.
- Add regression tests for both execution modes.

### 5. Feature UI and bulk controls

- Add an accessible execution-mode selector and three-role editor to Add/Edit Feature.
- Add orchestration to Mass Edit.
- Extend Balance Models for selected/all backlog features with automatic verified orchestration and manual role overrides.
- Reuse collapsible provider groups and persistent provider enable/disable settings.
- Add component tests before implementing each UI surface.

### 6. Verification and packaging

- Run focused unit/component tests during implementation.
- Run package, server, and UI type/build verification.
- Run relevant Playwright flows without live model spend.
- Build the Electron package and report its exact output path.

## Guardrails

- Preserve user-owned dirty and untracked files.
- Do not hardcode exact current model versions.
- Do not call live paid models in automated tests.
- Do not change single-model defaults or behavior.
- Do not allow same-provider lead and reviewer assignments.
- Do not mark orchestrated work verified without a parsed persisted approval.
