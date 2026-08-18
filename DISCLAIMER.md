# Security Disclaimer

## Important warning

**AboardAI runs AI-powered tools that may read, modify, or delete files and execute commands with the permissions available to the AboardAI server and the selected provider. Use it at your own risk.**

Supported provider integrations include Claude, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, and user-configured Claude-compatible endpoints. Provider behavior, model output, and tool permissions can vary.

## Risks

An agent may:

- Read source code, configuration, environment variables, and other accessible files.
- Write, rename, or delete files.
- Execute shell commands and project scripts.
- Create git branches, worktrees, commits, pushes, or pull requests when the corresponding workflow is invoked and credentials permit it.
- Produce incorrect, insecure, incomplete, or destructive changes.

Git worktrees reduce checkout contention but are not a security sandbox. Application login protects the HTTP API; it does not limit what an authenticated agent process can do on the host.

## Recommended precautions

1. Review the source and provider permissions before use.
2. Keep important work committed and backed up.
3. Restrict filesystem access with `ALLOWED_ROOT_DIRECTORY`.
4. Use a dedicated account, virtual machine, container, or other sandbox when stronger isolation is required.
5. Review streamed tool activity, diffs, and test output before accepting or merging changes.
6. Keep credentials out of projects and protect the AboardAI data directory.

## Docker isolation

The default `docker-compose.yml` uses Docker-managed volumes and does not mount host project directories. This prevents the container from reading host projects by default. If you add a bind mount through an override file, every mounted path is intentionally exposed to the container and its agents.

```bash
docker compose up -d --build

# UI
# http://localhost:47821

# API health check
# http://localhost:47820/api/health
```

See [Docker deployment and isolation](docs/docker.md) for the current compose files, provider credentials, and host-mount examples.

## No warranty and limitation of liability

THE SOFTWARE UTILIZES ARTIFICIAL INTELLIGENCE TO GENERATE CODE, EXECUTE COMMANDS, AND INTERACT WITH FILESYSTEMS AND EXTERNAL SERVICES. AI SYSTEMS CAN BE UNPREDICTABLE AND MAY GENERATE INCORRECT, INSECURE, OR DESTRUCTIVE RESULTS.

This software is provided “as is,” without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, including data loss, financial loss, hardware damage, or business interruption, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or its use.

By using AboardAI, you accept responsibility for the permissions you grant, the credentials you configure, and the actions performed in your environment.
