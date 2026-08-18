# Docker deployment and isolation

AboardAI includes one production compose file and two development variants:

| File                            | Purpose                                                            | Published ports         |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `docker-compose.yml`            | Built server and nginx-hosted UI                                   | UI `47821`, API `47820` |
| `docker-compose.dev.yml`        | Server and Vite UI with source mounts and live reload              | UI `47821`, API `47820` |
| `docker-compose.dev-server.yml` | Containerized development API for a locally run UI or Electron app | API `47820`             |

## Isolated production setup

The default production compose file uses only Docker-managed volumes. It does not mount a host project directory, so agents cannot read host projects through the container unless you add a bind mount.

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

Open `http://localhost:47821`. The API health endpoint is `http://localhost:47820/api/health`.

The server runs as the non-root `aboardai` user. Set `UID` and `GID` in `.env` before building if bind-mounted files must use your host user’s numeric IDs:

```dotenv
UID=1000
GID=1000
```

## Granting access to host projects

Copy `docker-compose.override.yml.example` to `docker-compose.override.yml` and replace the example path:

```yaml
services:
  server:
    volumes:
      - /path/to/workspace:/projects:rw
    environment:
      - ALLOWED_ROOT_DIRECTORY=/projects
```

On Windows, use a Docker-compatible absolute path such as `C:/Projects:/projects:rw`.

This bind mount deliberately grants the server and its agents read/write access to that host directory. `ALLOWED_ROOT_DIRECTORY=/projects` limits AboardAI’s validated filesystem operations to the mounted container path; it is not a substitute for reviewing Docker and provider permissions.

## Application login

The server loads `ABOARDAI_API_KEY` from the environment or generates and persists a key when none is supplied. In web mode, use the key printed in the server logs to sign in:

```bash
docker compose logs server
```

To supply a stable key, add it to `.env`:

```dotenv
ABOARDAI_API_KEY=replace-with-a-long-random-value
```

`ABOARDAI_AUTO_LOGIN=true` is development-only and is ignored in production.

## Provider authentication

The production image installs the Claude CLI, Cursor agent CLI, OpenCode CLI, and GitHub CLI. The server package also contains the Codex and GitHub Copilot SDK integrations. Gemini CLI is not installed by the production Dockerfile.

The default compose file persists container-local Claude, Cursor, and OpenCode configuration in named volumes. You can authenticate interactively inside the container where the provider supports it, supply supported environment credentials, or deliberately mount host configuration through an override.

### Claude

Supported server credentials include `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and Claude CLI OAuth state. The compose file also accepts `CLAUDE_OAUTH_CREDENTIALS` for the macOS extraction flow provided by `scripts/get-claude-token.sh`.

```dotenv
ANTHROPIC_API_KEY=replace-me
```

To share a host Claude CLI directory instead, add a bind mount and understand that it exposes writable credential state to the container:

```yaml
services:
  server:
    volumes:
      - ~/.claude:/home/aboardai/.claude
```

### Cursor

The compose file accepts `CURSOR_AUTH_TOKEN`. On macOS, `scripts/get-cursor-token.sh` extracts the Cursor agent token; on Linux, the script documents the CLI auth file it reads.

```dotenv
CURSOR_AUTH_TOKEN=replace-me
```

You may instead mount the relevant Cursor CLI configuration directory through an override.

### OpenCode

Named volumes persist OpenCode data, configuration, and cache. Authenticate using the OpenCode CLI in the container, or mount the matching host directories as shown in `docker-compose.override.yml.example`.

### Codex, Gemini, and GitHub Copilot

- Codex can use `OPENAI_API_KEY`; CLI-authenticated tool execution requires a Codex CLI installation and login available inside the container.
- Gemini can use `GEMINI_API_KEY` or supported Google/Vertex credentials, but the default image does not install Gemini CLI.
- GitHub Copilot recognizes GitHub CLI/Copilot authentication or `GITHUB_TOKEN`; GitHub CLI is installed in the image.

Do not assume a provider is ready merely because its package exists. Check **Settings → Providers** and verify access before assigning work.

## GitHub operations

For git pushes or pull requests, supply git identity and GitHub authentication only if those operations are intended:

```yaml
services:
  server:
    volumes:
      - ~/.gitconfig:/home/aboardai/.gitconfig:ro
      - ~/.config/gh:/home/aboardai/.config/gh
    environment:
      - GH_TOKEN=${GH_TOKEN}
```

On Windows, GitHub CLI configuration is commonly under `C:/Users/YourName/AppData/Roaming/GitHub CLI`.

## Playwright browsers

The production image installs Playwright Chromium. A named browser-cache volume is optional; adding an empty volume over the preinstalled cache requires reinstalling Chromium into that volume:

```bash
docker exec --user aboardai -w /app aboardai-server npx playwright install chromium
```

## Development compose files

`docker-compose.dev.yml` bind-mounts the repository into `/app`, installs dependencies in a named volume, and runs the server and Vite UI with live reload. `docker-compose.dev-server.yml` runs only the API for a local Electron or browser UI. These development modes intentionally have broader source access than the isolated production compose file.
