# Provider architecture

The AboardAI server routes agent requests through a shared provider abstraction in `apps/server/src/providers/`. This document describes the current registry and execution paths.

## Registered providers

`apps/server/src/providers/provider-factory.ts` registers these built-in providers:

| Registry name | Adapter            | Primary runtime                                             | Model routing                                                    |
| ------------- | ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `claude`      | `ClaudeProvider`   | Claude Agent SDK                                            | Claude IDs and aliases such as haiku, sonnet, and opus           |
| `cursor`      | `CursorProvider`   | Cursor agent CLI or supported Cursor IDE agent subcommand   | Cursor-prefixed and recognized Cursor models                     |
| `codex`       | `CodexProvider`    | Codex SDK or Codex CLI, selected from auth/capability needs | Codex-prefixed and recognized Codex models                       |
| `opencode`    | `OpencodeProvider` | OpenCode CLI                                                | OpenCode-prefixed models and discovered OpenCode catalog entries |
| `gemini`      | `GeminiProvider`   | Gemini CLI                                                  | Gemini-prefixed and recognized Gemini models                     |
| `copilot`     | `CopilotProvider`  | GitHub Copilot SDK/CLI integration                          | Copilot-prefixed and recognized Copilot models                   |

`ABOARDAI_MOCK_AGENT=true` bypasses real providers and returns the shared `MockProvider` for automated tests.

Claude-compatible endpoints are an additional configuration path rather than separate registry entries. A `ClaudeCompatibleProvider` supplies a base URL, credential source, and model list to `ClaudeProvider`. See [Claude-compatible providers](../UNIFIED_API_KEY_PROFILES.md).

## Core contract

`BaseProvider` defines the common behavior expected by services:

- Execute an agent request as an async stream of `ProviderMessage` values.
- Detect installation and authentication state.
- Advertise model definitions and capabilities.
- Validate provider-specific configuration.
- Honor abort signals and normalize errors.

The shared request, message, content-block, model, and MCP types live in `@aboardai/types` and are re-exported from `apps/server/src/providers/types.ts`. Provider implementations should not introduce UI-only event shapes.

## Routing

`ProviderFactory.getProviderNameForModel()` checks registered `canHandleModel` functions by priority, then explicit provider prefixes, and finally falls back to Claude for legacy unprefixed aliases. The current priority order prevents overlapping GPT-family names from being captured by the wrong provider.

Services normally pass the saved model through `resolveModelString()` from `@aboardai/model-resolver` before execution. A saved `providerId` is reserved for a configured Claude-compatible endpoint; native providers are selected from the model ID.

If a user disconnects a built-in provider, AboardAI writes a marker under the active `.aboardai/` working directory. Provider creation rejects that adapter until it is reconnected under **Settings → Providers**.

## Execution paths

### Claude

`ClaudeProvider` uses `@anthropic-ai/claude-agent-sdk`. It recognizes an application-managed Anthropic key, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or Claude CLI OAuth indicators. A configured Claude-compatible provider can override the endpoint and credential source for one request without changing process-wide settings.

### Codex

`CodexProvider` chooses between the Codex SDK and CLI based on available authentication and requested capabilities. CLI-native login takes priority for CLI-backed tool execution; an application-managed or environment `OPENAI_API_KEY` enables the SDK path where supported. MCP requests can require the CLI path.

### Cursor

`CursorProvider` discovers a `cursor-agent` binary or a supported `cursor agent` subcommand. The server queries `--list-models`, caches results for five minutes, and falls back to `CURSOR_MODEL_MAP` if discovery fails. Login state or `CURSOR_API_KEY` is detected separately from installation.

### Gemini

`GeminiProvider` uses the Gemini CLI. It recognizes `GEMINI_API_KEY`, supported Google/Vertex environment credentials, and configured Gemini CLI authentication. The CLI does not expose all capability controls used by other providers, so unsupported settings must not be silently translated.

### OpenCode

`OpencodeProvider` uses the OpenCode CLI, discovers models with `opencode models`, and inspects configured providers through `opencode auth list`. The available model catalog depends on the user’s OpenCode configuration.

### GitHub Copilot

`CopilotProvider` uses the GitHub Copilot integration and checks GitHub CLI/Copilot authentication or `GITHUB_TOKEN`. Authentication does not guarantee that a particular account is entitled to every advertised model, so access verification remains a separate step.

## Model access verification

`apps/server/src/services/model-access-verifier.ts` probes selected model candidates with a read-only, tool-free request. Probes are bounded by a timeout and concurrency limit, and errors are reduced to sanitized authentication, billing, rate-limit, timeout, or generic messages.

Catalog presence, provider installation, authentication detection, and successful model access are distinct states. UI and documentation should not collapse them into a single “supported” boolean.

## Authentication routes

Provider setup routes live in `apps/server/src/routes/setup/` and expose status, connect/disconnect, installation, model-discovery, and supported credential-management actions. The built-in provider names are Claude, Codex, Cursor, Gemini, OpenCode, and Copilot.

AboardAI application authentication in `apps/server/src/lib/auth.ts` is unrelated to provider authentication. Passing the AboardAI login gate does not prove that any model provider is ready.

## Adding or changing a provider

1. Implement or update a `BaseProvider` adapter under `apps/server/src/providers/`.
2. Keep provider-specific event parsing inside the adapter and return normalized `ProviderMessage` values.
3. Register the adapter in `provider-factory.ts` with a non-ambiguous `canHandleModel` predicate and deliberate priority.
4. Add model ID/type guards in `@aboardai/types` and resolution support in `@aboardai/model-resolver` when needed.
5. Add setup status/authentication routes and settings UI only for behaviors the adapter actually implements.
6. Test routing collisions, installation detection, authentication states, aborts, tool events, errors, and conversation continuation.
7. Update this document and user-facing setup copy.

Do not add a provider by hard-coding it only in a model picker. Server routing and authentication are the authority for executable support.

## Verification commands

```bash
npm run build:packages
npm run test:packages
npm run test:server
npm run build:server
```

Run the focused provider tests while developing, then include the full server gate before merging. Real-provider smoke tests should be explicit and must not expose credentials in logs or fixtures.
