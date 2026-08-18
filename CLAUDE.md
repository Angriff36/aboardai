# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AboardAI is an autonomous AI development studio built as an npm workspace monorepo. It provides Kanban, planning, chat, pipeline, and worktree workflows across multiple AI providers. Features can run in the current checkout or a configured git worktree.

## Common Commands

```bash
# Development
npm run dev                 # Interactive launcher (web, Electron, and Docker modes)
npm run dev:web             # Web browser mode (localhost:47821)
npm run dev:electron        # Desktop app mode
npm run dev:electron:debug  # Desktop with DevTools open

# Building
npm run build               # Build web application
npm run build:packages      # Build all shared packages (required before other builds)
npm run build:electron      # Build desktop app for current platform
npm run build:server        # Build server only

# Testing
npm run test                # E2E tests (Playwright, headless)
npm run test:headed         # E2E tests with browser visible
npm run test:server         # Server unit tests (Vitest)
npm run test:packages       # All shared package tests
npm run test:all            # All tests (packages + server)

# Single test file
npm run test:server -- tests/unit/specific.test.ts

# Linting and formatting
npm run lint                # ESLint
npm run format              # Prettier write
npm run format:check        # Prettier check
```

## Architecture

### Monorepo Structure

```
aboardai/
├── apps/
│   ├── ui/           # React + Vite + Electron frontend (port 47821)
│   └── server/       # Express + WebSocket backend (port 47820)
└── libs/             # Shared packages (@aboardai/*)
    ├── types/        # Core TypeScript definitions (no dependencies)
    ├── utils/        # Logging, errors, image processing, context loading
    ├── prompts/      # AI prompt templates
    ├── platform/     # Path management, security, process spawning
    ├── model-resolver/    # Model aliases and provider routing helpers
    ├── dependency-resolver/  # Feature dependency ordering
    ├── spec-parser/  # Specification parsing and validation
    └── git-utils/    # Git operations & worktree management
```

### Package Dependency Chain

Packages can only depend on packages above them:

```
@aboardai/types (no dependencies)
    ↓
@aboardai/utils, @aboardai/prompts, @aboardai/platform, @aboardai/model-resolver, @aboardai/dependency-resolver, @aboardai/spec-parser
    ↓
@aboardai/git-utils
    ↓
@aboardai/server, @aboardai/ui
```

### Key Technologies

- **Frontend**: React 19, Vite 7, Electron 39, TanStack Router, Zustand 5, Tailwind CSS 4
- **Backend**: Express 5, WebSocket (ws), provider SDK/CLI adapters, node-pty
- **Testing**: Playwright (E2E), Vitest (unit)

### Server Architecture

The server (`apps/server/src/`) follows a modular pattern:

- `routes/` - Express route handlers organized by feature (agent, features, auto-mode, worktree, etc.)
- `services/` - Business logic (AgentService, AutoModeService, FeatureLoader, TerminalService)
- `providers/` - Claude, Codex, Cursor, Gemini, OpenCode, and GitHub Copilot adapters
- `lib/` - Utilities (events, auth, worktree metadata)

### Frontend Architecture

The UI (`apps/ui/src/`) uses:

- `routes/` - TanStack Router file-based routing
- `components/views/` - Main view components (board, settings, terminal, etc.)
- `store/` - Zustand stores with persistence (app-store.ts, setup-store.ts)
- `hooks/` - Custom React hooks
- `lib/` - Utilities and API client

## Data Storage

### Per-Project Data (`.aboardai/`)

```
.aboardai/
├── features/              # Feature JSON files and images
│   └── {featureId}/
│       ├── feature.json
│       ├── agent-output.md
│       └── images/
├── context/               # Context files for AI agents (CLAUDE.md, etc.)
├── ideation/              # Ideas, sessions, drafts, and analysis
├── events/                # Persisted normalized event history
├── settings.json          # Project-specific settings
├── app_spec.txt           # Project specification
├── notifications.json     # Project notifications
└── execution-state.json   # Interrupted/running feature recovery state
```

### Global Data (`DATA_DIR`, default `./data`)

```
data/
├── settings.json          # Global settings, profiles, shortcuts
├── credentials.json       # API keys
├── sessions-metadata.json # Chat session metadata
└── agent-sessions/        # Conversation histories
```

## Import Conventions

Always import from shared packages, never from old paths:

```typescript
// ✅ Correct
import type { Feature, ExecuteOptions } from '@aboardai/types';
import { createLogger, classifyError } from '@aboardai/utils';
import { getEnhancementPrompt } from '@aboardai/prompts';
import { getFeatureDir, ensureAboardaiDir } from '@aboardai/platform';
import { resolveModelString } from '@aboardai/model-resolver';
import { resolveDependencies } from '@aboardai/dependency-resolver';
import { getGitRepositoryDiffs } from '@aboardai/git-utils';

// ❌ Never import from old paths
import { Feature } from '../services/feature-loader'; // Wrong
import { createLogger } from '../lib/logger'; // Wrong
```

## Key Patterns

### Event-Driven Architecture

All server operations emit events that stream to the frontend via WebSocket. Events are created using `createEventEmitter()` from `lib/events.ts`.

### Git Worktree Isolation

Features can run in the current checkout or in a dedicated git worktree. The add/edit flows create and associate worktrees when automatic or custom worktree mode is selected. Worktrees reduce branch contention but are not a security boundary.

### Context Files

Project-specific rules are stored in `.aboardai/context/` and automatically loaded into agent prompts via `loadContextFiles()` from `@aboardai/utils`.

### Model Resolution

Use `resolveModelString()` from `@aboardai/model-resolver` to convert model aliases:

- `haiku` → `claude-haiku-4-5-20251001`
- `sonnet` → `claude-sonnet-4-6`
- `opus` → `claude-opus-4-8`
- `fable` → `claude-fable-5` (listed in model catalogs, but currently marked non-implementation-capable and never selected as a default; capabilities remain provisional)

## Environment Variables

- `ANTHROPIC_API_KEY` - Anthropic API key (or use Claude Code CLI auth)
- `OPENAI_API_KEY` - OpenAI API key for supported Codex execution paths
- `CURSOR_API_KEY` - Cursor API key alternative to Cursor CLI login
- `GEMINI_API_KEY` - Gemini API key alternative to Gemini CLI login
- `GITHUB_TOKEN` - GitHub/Copilot token alternative where supported
- `HOST` - Host to bind server to (default: 0.0.0.0)
- `HOSTNAME` - Hostname for user-facing URLs (default: localhost)
- `PORT` - Server port (default: 47820)
- `DATA_DIR` - Data storage directory (default: ./data)
- `ALLOWED_ROOT_DIRECTORY` - Restrict file operations to specific directory
- `ABOARDAI_MOCK_AGENT=true` - Enable mock agent mode for CI testing
- `ABOARDAI_AUTO_LOGIN=true` - Skip login prompt in development (disabled when NODE_ENV=production)
- `VITE_HOSTNAME` - Hostname for frontend API URLs (default: localhost)

# === COGNILAYER (auto-generated, do not delete) ===

## CogniLayer v4 Active

Persistent memory + code intelligence is ON.
ON FIRST USER MESSAGE in this session, briefly tell the user:
'CogniLayer v4 active — persistent memory is on. Type /cognihelp for available commands.'
Say it ONCE, keep it short, then continue with their request.

## Tools — HOW TO WORK

FIRST RUN ON A PROJECT:
When DNA shows "[new session]" or "[first session]":

1. Run /onboard — indexes project docs (PRD, README), builds initial memory
2. Run code_index() — builds AST index for code intelligence
   Both are one-time. After that, updates are incremental.
   If file_search or code_search return empty → these haven't been run yet.

UNDERSTAND FIRST (before making changes):

- memory_search(query) → what do we know? Past bugs, decisions, gotchas
- code_context(symbol) → how does the code work? Callers, callees, dependencies
- file_search(query) → search project docs (PRD, README) without reading full files
- code_search(query) → find where a function/class is defined
  Use BOTH memory + code tools for complete picture. They are fast — call in parallel.

BEFORE RISKY CHANGES (mandatory):

- Renaming, deleting, or moving a function/class → code_impact(symbol) FIRST
- Changing a function's signature or return value → code_impact(symbol) FIRST
- Modifying shared utilities used across multiple files → code_impact(symbol) FIRST
- ALSO: memory_search(symbol) → check for related decisions or known gotchas
  Both required. Structure tells you what breaks, memory tells you WHY it was built that way.

AFTER COMPLETING WORK:

- memory_write(content) → save important discoveries immediately
  (error_fix, gotcha, pattern, api_contract, procedure, decision)
- session_bridge(action="save", content="Progress: ...; Open: ...")
  DO NOT wait for /harvest — session may crash.

SUBAGENT MEMORY PROTOCOL:
When spawning Agent tool for research or exploration:

- Include in prompt: synthesize findings into consolidated memory_write(content, type, tags="subagent,<task-topic>") facts
  Assign a descriptive topic tag per subagent (e.g. tags="subagent,auth-review", tags="subagent,perf-analysis")
- Do NOT write each discovery separately — group related findings into cohesive facts
- Write to memory as the LAST step before return, not incrementally — saves turns and tokens
- Each fact must be self-contained with specific details (file paths, values, code snippets)
- When findings relate to specific files, include domain and source_file for better search and staleness detection
- End each fact with 'Search: keyword1, keyword2' — keywords INSIDE the fact survive context compaction
- Record significant negative findings too (e.g. 'no rate limiting exists in src/api/' — prevents repeat searches)
- Return: actionable summary (file paths, function names, specific values) + what was saved + keywords for memory_search
- If MCP tools unavailable or fail → include key findings directly in return text as fallback
- Launch subagents as foreground (default) for reliable MCP access — user can Ctrl+B to background later
  Why: without this protocol, subagent returns dump all text into parent context (40K+ tokens).
  With protocol, findings go to DB and parent gets ~500 token summary + on-demand memory_search.

BEFORE DEPLOY/PUSH:

- verify_identity(action_type="...") → mandatory safety gate
- If BLOCKED → STOP and ask the user
- If VERIFIED → READ the target server to the user and request confirmation

## VERIFY-BEFORE-ACT

When memory_search returns a fact marked ⚠ STALE:

1. Read the source file and verify the fact still holds
2. If changed → update via memory_write
3. NEVER act on STALE facts without verification

## Process Management (Windows)

- NEVER use `taskkill //F //IM node.exe` — kills ALL Node.js INCLUDING Claude Code CLI!
- Use: `npx kill-port PORT` or find PID via `netstat -ano | findstr :PORT` then `taskkill //F //PID XXXX`

## Git Rules

- Commit often, small atomic changes. Format: "[type] what and why"
- commit = Tier 1 (do it yourself). push = Tier 3 (verify_identity).

## Project DNA: aboardai

Stack: unknown
Style: [unknown]
Structure: ?
Deploy: [NOT SET]
Active: [new session]
Last: [first session]

## Last Session Bridge

[Emergency bridge — running bridge was not updated]
No changes or facts in this session.

# === END COGNILAYER ===
