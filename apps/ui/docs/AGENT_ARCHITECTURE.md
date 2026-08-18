# Agent architecture

This document describes the current AboardAI agent path. The application no longer uses the inherited Next.js API-route or Electron-renderer execution design.

## Runtime ownership

Agent execution belongs to the Express backend in `apps/server/src/` in both run modes:

```text
React/Vite renderer
  -> HTTP commands through apps/ui/src/lib/http-api-client.ts
  -> WebSocket events from /api/events
  -> Express routes in apps/server/src/routes/
  -> AgentService or AutoModeService
  -> provider selected by ProviderFactory
  -> normalized events and persisted project/session state
```

In browser mode, the UI connects to the separately started backend. In Electron mode, `apps/ui/src/electron/server/backend-server.ts` launches and monitors the same backend, while `apps/ui/src/electron/windows/main-window.ts` loads the Vite development page or packaged static UI.

The Electron main process manages the local backend and application window. It does not contain a separate Claude-only agent implementation.

## Main components

### UI transport

- `apps/ui/src/lib/http-api-client.ts` exposes typed HTTP calls for sessions, features, Auto Mode, worktrees, settings, providers, and other server capabilities.
- `apps/ui/src/hooks/use-electron-agent.ts` is the renderer-facing agent hook retained for UI compatibility; its operations resolve through the backend API.
- `apps/ui/src/hooks/use-agent-output-websocket.ts` consumes streamed feature output.
- `apps/ui/src/routes/agent.tsx` renders the persistent agent-chat view.

### Server routes

- `apps/server/src/routes/agent/` starts, sends to, stops, clears, changes models for, and queues prompts in agent-chat sessions.
- `apps/server/src/routes/sessions/` creates, lists, updates, archives, unarchives, and deletes session metadata.
- `apps/server/src/routes/auto-mode/` runs feature agents, planning, verification, follow-ups, and recovery.
- `apps/server/src/routes/models/` reports provider/model availability and verifies model access.

All protected routes pass through the server authentication middleware. The renderer does not gain filesystem or agent authority merely by being loaded.

### Services

- `AgentService` owns interactive chat sessions, prompt queues, provider execution, and conversation persistence.
- `AutoModeServiceCompat` exposes the feature-execution facade used by routes.
- `ExecutionService` builds feature prompts, resolves worktrees, runs planning or orchestration, updates feature state, and records output.
- `AgentExecutor` handles the detailed planning/task execution loop.
- `ProviderFactory` routes model IDs to registered provider adapters.

### Providers

The current registry in `apps/server/src/providers/provider-factory.ts` includes Claude, Codex, Cursor, Gemini, OpenCode, and GitHub Copilot. `ClaudeCompatibleProvider` settings can route Claude-protocol requests to configured endpoints such as OpenRouter, z.AI, MiniMax, or a custom service.

Provider output is normalized before it is presented to the UI. Provider-specific event formats should not leak into renderer components.

## Streaming and persistence

The backend creates a shared event emitter in `apps/server/src/lib/events.ts` and exposes it over `/api/events`. UI consumers subscribe to normalized events for agent messages, tool activity, feature progress, tests, notifications, and other long-running operations.

Interactive session metadata is stored in `DATA_DIR/sessions-metadata.json`; message histories are stored under `DATA_DIR/agent-sessions/`. Feature state and output are stored in the opened project under `.aboardai/features/<feature-id>/`.

Persist-before-emit behavior is important for state-changing operations: after a reload or reconnect, the UI refetches authoritative state rather than relying on previously streamed events.

## Restart behavior

A Vite renderer reload does not stop the separately running Express backend, so active backend work can continue while the UI reconnects.

A backend or application shutdown is different. The server’s graceful-shutdown path marks running features as interrupted before closing. After restart, the persisted state supports reconciliation and explicit resume flows; the documentation must not claim that an agent process survives a backend process restart.

## Authentication boundaries

AboardAI application authentication and provider authentication are separate:

- `apps/server/src/lib/auth.ts` protects HTTP and WebSocket access with the AboardAI API key/session mechanism.
- Each provider detects its own CLI, OAuth, API-key, or token state.
- Electron generates and supplies its local backend key through `apps/ui/src/electron/security/api-key-manager.ts`.

## Testing

- Server behavior is covered by the Vitest server project: `npm run test:server`.
- Shared provider/model behavior is covered by `npm run test:packages` and server tests.
- End-to-end renderer/server behavior is covered by Playwright: `npm run test`.
- `ABOARDAI_MOCK_AGENT=true` routes automated agent execution through the mock provider.

When changing this architecture, test the server lifecycle, reconnect behavior, event ordering, session persistence, and at least one representative UI flow.
