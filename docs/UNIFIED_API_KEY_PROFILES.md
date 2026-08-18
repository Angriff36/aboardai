# Claude-compatible providers

AboardAI can route Claude-protocol requests through user-configured API endpoints without treating each endpoint as a separate built-in provider adapter. These configurations are called `ClaudeCompatibleProvider` records.

This system is separate from the built-in Claude, Codex, Cursor, Gemini, OpenCode, and GitHub Copilot providers described in [server provider architecture](server/providers.md).

## Configuration model

The source of truth is `libs/types/src/settings.ts`:

```typescript
export type ClaudeCompatibleProviderType =
  | 'anthropic'
  | 'glm'
  | 'minimax'
  | 'openrouter'
  | 'custom';

export type ApiKeySource = 'inline' | 'env' | 'credentials';

export interface ClaudeCompatibleProvider {
  id: string;
  name: string;
  providerType: ClaudeCompatibleProviderType;
  enabled?: boolean;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKey?: string;
  useAuthToken?: boolean;
  timeoutMs?: number;
  disableNonessentialTraffic?: boolean;
  models: ProviderModel[];
  providerSettings?: Record<string, unknown>;
}
```

Each `ProviderModel` has an ID sent to the endpoint, a display name, an optional Claude-tier mapping, and optional capability metadata. Phase and feature model selections save the provider record’s `id` separately:

```typescript
export interface PhaseModelEntry {
  providerId?: string;
  model: ModelId;
  thinkingLevel?: ThinkingLevel;
  reasoningEffort?: ReasoningEffort;
}
```

Built-in provider models do not use `providerId`; their model IDs route through `ProviderFactory`.

## Templates

`CLAUDE_PROVIDER_TEMPLATES` currently includes:

| Template         | Provider type | Default base URL                     |
| ---------------- | ------------- | ------------------------------------ |
| Direct Anthropic | `anthropic`   | `https://api.anthropic.com`          |
| OpenRouter       | `openrouter`  | `https://openrouter.ai/api`          |
| z.AI GLM         | `glm`         | `https://api.z.ai/api/anthropic`     |
| MiniMax          | `minimax`     | `https://api.minimax.io/anthropic`   |
| MiniMax China    | `minimax`     | `https://api.minimaxi.com/anthropic` |

Templates are editable starting points, not a guarantee that every default model is available to every account. Users can add, remove, or rename exposed model IDs in Settings.

## Credential sources

- `inline` uses the key saved on the provider record.
- `env` reads `ANTHROPIC_API_KEY` from the server environment.
- `credentials` reads the application-managed Anthropic key from `DATA_DIR/credentials.json`.

`useAuthToken` controls whether the request environment uses the Anthropic auth-token convention rather than the API-key convention. The selected endpoint may have provider-specific requirements.

Application-managed credentials are not described by `SettingsService` as encrypted at rest. Protect `DATA_DIR`, avoid committing settings or credentials, and do not include keys in screenshots, logs, tests, or issue reports.

## Resolution path

`apps/server/src/lib/settings-helpers.ts` resolves provider context for a request:

1. Load global settings and the configured provider list.
2. Resolve an explicit `providerId` when one is saved on the feature or phase model.
3. Reject or skip a disabled provider.
4. Resolve the provider-specific model and credentials.
5. Pass the provider record and credentials to the Claude execution path.

`apps/server/src/providers/claude-provider.ts` builds a request-scoped environment from that context. Provider endpoint or model-map variables must not leak into unrelated direct-Anthropic requests.

## UI and persistence

The Settings provider editor manages `claudeCompatibleProviders`. Enabled records contribute provider groups and model options to shared model selectors. Disabling a provider removes its candidates from new selections without deleting the record.

Global records are stored in `DATA_DIR/settings.json`. Project settings under `<project>/.aboardai/settings.json` can override phase model selections; the referenced provider definition remains global.

Legacy `ClaudeApiProfile` and `claudeApiProfiles` types remain only for migration. New code should use `ClaudeCompatibleProvider` and `claudeCompatibleProviders`.

## Verification

Before assigning work to a configured endpoint:

1. Confirm the base URL and credential source.
2. Enable the provider and expose only verified model IDs.
3. Use the model access verification flow in the UI.
4. Check that a disabled provider disappears from candidate lists.
5. Confirm direct Anthropic and other configured providers still use their own credentials after the request.

Relevant automated gates are:

```bash
npm run test:server
npm run test:packages
npm run typecheck
```
