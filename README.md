# AboardAI

AboardAI is an actively developed, self-hosted AI development studio. It gives developers a project dashboard, Kanban workflow, agent chat, planning tools, and git worktree controls for coordinating AI-assisted feature work from one application.

AboardAI runs as either an Electron desktop application or a browser application backed by the same Express and WebSocket server. Agent execution remains under your control: choose a provider and model, decide whether work happens on the current checkout or in a dedicated worktree, review streamed activity and diffs, and approve the result.

## What AboardAI does

- Manages projects and feature cards across backlog, active, review, and completed states.
- Runs features manually or through Auto Mode with configurable concurrency and dependency blocking.
- Supports skip, lite, spec, and full planning modes, including optional plan approval.
- Creates and manages git worktrees, branches, commits, diffs, merges, pushes, and pull requests.
- Streams normalized agent events, tool activity, test output, and feature status over WebSocket.
- Supports reusable pipelines, grouped work, and orchestrated lead/workhorse/reviewer execution.
- Provides persistent agent chat sessions, prompt queues, context files, specifications, ideation, and project analysis.
- Includes GitHub issue and pull-request review workflows, a dependency graph, file editor, and integrated terminal.
- Stores project state in the project’s `.aboardai/` directory so feature records travel with the repository.

These capabilities are implemented in the current repository. Some depend on local tooling, provider credentials, git configuration, or project settings.

## Supported AI providers

The server currently registers six built-in execution providers:

| Provider       | Integration        | Authentication recognized by AboardAI                                      |
| -------------- | ------------------ | -------------------------------------------------------------------------- |
| Claude         | Claude Agent SDK   | Claude CLI credentials, `ANTHROPIC_API_KEY`, or an Anthropic auth token    |
| Codex          | Codex SDK and CLI  | `codex login` credentials or `OPENAI_API_KEY`                              |
| Cursor         | Cursor agent CLI   | Cursor agent login or `CURSOR_API_KEY`                                     |
| Gemini         | Gemini CLI         | Gemini CLI login, `GEMINI_API_KEY`, or supported Google/Vertex credentials |
| OpenCode       | OpenCode CLI       | Providers configured through OpenCode authentication                       |
| GitHub Copilot | GitHub Copilot SDK | GitHub CLI/Copilot authentication or `GITHUB_TOKEN`                        |

AboardAI also supports user-configured Claude-compatible API endpoints. Templates currently exist for direct Anthropic, OpenRouter, z.AI GLM, and MiniMax endpoints, with a custom endpoint option. See [Claude-compatible providers](docs/UNIFIED_API_KEY_PROFILES.md) and [provider architecture](docs/server/providers.md).

Available models are resolved from the selected provider and local configuration. Cursor and OpenCode can discover models from their installed CLIs, so the UI is not limited to a permanently hard-coded catalog.

Provider credentials are separate from AboardAI application login. In web mode, the server generates or loads an `ABOARDAI_API_KEY`; enter the key printed by the server to establish the session cookie. Electron supplies its local server key automatically. Development-only auto-login is available through `ABOARDAI_AUTO_LOGIN=true` and is disabled in production.

## Requirements

- Node.js `>=22.0.0 <23.0.0`
- npm
- Git, including worktree support for isolated feature work
- At least one supported provider configured for real agent execution

Provider CLIs are not all mandatory. Install and authenticate only the provider or providers you plan to use, then confirm their status under **Settings → Providers**.

## Install and run

```bash
git clone https://github.com/Angriff36/aboardai.git
cd aboardai
npm install
npm run dev
```

`npm run dev` opens the interactive launcher. Direct commands are also available:

```bash
npm run dev:web              # Browser UI at http://localhost:47821
npm run dev:electron         # Electron desktop application
npm run dev:electron:debug   # Electron with DevTools open
npm run dev:server           # Backend only at http://localhost:47820
npm run dev:full             # Backend and browser UI together
```

The launcher also exposes Docker-oriented development modes. Run `./start-aboardai.sh --help` from Bash for its current options.

### Ports

| Service                       | Default | Override                                          |
| ----------------------------- | ------: | ------------------------------------------------- |
| Backend HTTP/WebSocket server | `47820` | `PORT` or launcher-managed `ABOARDAI_SERVER_PORT` |
| Browser/Vite UI               | `47821` | `ABOARDAI_WEB_PORT`                               |
| Playwright UI                 |  `3107` | `TEST_PORT`                                       |
| Playwright backend            |  `3108` | `TEST_SERVER_PORT`                                |

## Build and test

```bash
npm run build                 # Shared packages + browser UI
npm run build:packages        # All @aboardai/* shared packages
npm run build:server          # Shared packages + Express server
npm run build:electron        # Desktop package for the current platform
npm run build:electron:win    # Windows NSIS, x64
npm run build:electron:mac    # macOS DMG/ZIP, x64 + arm64
npm run build:electron:linux  # Linux AppImage/DEB/RPM, x64

npm run test                  # Playwright E2E suite
npm run test:headed           # Playwright with a visible browser
npm run test:packages         # Shared-package Vitest projects
npm run test:server           # Server Vitest project
npm run test:all              # All Vitest projects
npm run typecheck             # UI TypeScript check
npm run lint                  # UI ESLint
npm run format:check          # Repository Prettier check
```

Desktop artifacts are written to `apps/ui/release/`. The Electron application identity is `com.aboardai.app`, and the product name is `AboardAI`.

## Docker

The default production compose file publishes the UI on `47821` and the API on `47820`. It uses Docker-managed volumes and does not mount host project directories. Add an explicit override only when you intend to grant the container access to host projects or credentials.

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

Read [Docker deployment and isolation](docs/docker.md) before adding host mounts or provider credentials. Development variants are provided in `docker-compose.dev.yml` and `docker-compose.dev-server.yml`.

## Architecture

AboardAI is an npm workspace monorepo:

```text
apps/
  ui/       React 19, Vite 7, Electron 39, TanStack Router, Zustand, Tailwind CSS
  server/   Express 5, WebSocket, provider adapters, agents, worktrees, terminal

libs/
  types/                Shared TypeScript contracts
  utils/                Logging, errors, images, and context loading
  prompts/              Agent prompt templates
  platform/             Paths, filesystem security, and process discovery
  model-resolver/       Model aliases and provider routing helpers
  dependency-resolver/  Feature dependency ordering
  spec-parser/          Specification parsing and validation
  git-utils/            Git and worktree operations
```

The React renderer talks to the Express backend through HTTP APIs and WebSocket event streams in both web and Electron modes. In Electron, the main process launches and monitors the backend; it does not execute agents inside the renderer. See [agent architecture](apps/ui/docs/AGENT_ARCHITECTURE.md).

### Storage

Per-project state is stored under the opened project:

```text
.aboardai/
  features/<feature-id>/feature.json
  features/<feature-id>/agent-output.md
  features/<feature-id>/images/
  context/
  ideation/
  events/
  settings.json
  app_spec.txt
  notifications.json
  execution-state.json
```

Global state is stored under `DATA_DIR` (`./data` in normal development, the Electron user-data directory in packaged desktop builds, and `/data` in the production container):

```text
settings.json
credentials.json
sessions-metadata.json
agent-sessions/
```

Credentials in `credentials.json` are application-managed but are not described by the code as encrypted at rest. Protect the data directory accordingly.

## Security

Agents can read and modify files and execute commands with the permissions granted to the AboardAI server and provider tooling. Worktrees reduce branch contention; they are not a security boundary. Use `ALLOWED_ROOT_DIRECTORY` to restrict server file operations, review provider permissions, and use Docker or another sandbox when stronger isolation is required.

Read [DISCLAIMER.md](DISCLAIMER.md) before running agents against important data.

## Project status and support

AboardAI is actively developed. Bugs and feature requests for AboardAI should be filed in the [AboardAI issue tracker](https://github.com/Angriff36/aboardai/issues). Third-party communities and upstream Automaker channels are not official AboardAI support unless explicitly identified as such by this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current development and pull-request workflow.

## Origin and attribution

AboardAI originated as a fork of [Automaker](https://github.com/AutoMaker-Org/automaker). Automaker-derived code is used under the MIT License. Subsequent AboardAI development is maintained independently; Automaker’s maintainers do not maintain, sponsor, endorse, or support AboardAI.

See [LICENSE](LICENSE) for the license terms and [NOTICE](NOTICE) for upstream attribution and the recorded import point.

## License

MIT. The existing Automaker copyright and license notice is preserved alongside the AboardAI contributors’ notice in [LICENSE](LICENSE).
