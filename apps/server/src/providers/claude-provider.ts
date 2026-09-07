/**
 * Claude Provider - Executes queries using Claude Agent SDK (0.3.x)
 *
 * Wraps the @anthropic-ai/claude-agent-sdk for seamless integration
 * with the provider architecture.
 *
 * Design bias: reliability-first. Stream/session/env handling is defensive
 * and the SDK contract is treated as untrusted at the boundary:
 * - session_id is forwarded faithfully from the earliest init system message
 * - the stream is drained to completion (SDK 0.3 can emit messages AFTER result)
 * - result messages (including errors) are forwarded as-is for the supervisor
 * - per-model thinking/effort rules live in ONE capability table
 */

import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { BaseProvider } from './base-provider.js';
import {
  clearClaudeModelCache,
  getCachedClaudeModels,
  hasCachedClaudeModels,
  refreshClaudeModels,
} from './claude-model-discovery.js';
import { classifyError, getUserFriendlyErrorMessage, createLogger } from '@aboardai/utils';
import { getClaudeAuthIndicators } from '@aboardai/platform';
import {
  getThinkingTokenBudget,
  validateBareModelId,
  type ClaudeApiProfile,
  type ClaudeCompatibleProvider,
  type Credentials,
  type ReasoningEffort,
} from '@aboardai/types';
import type {
  ExecuteOptions,
  ProviderMessage,
  InstallationStatus,
  ModelDefinition,
} from './types.js';

const logger = createLogger('ClaudeProvider');

/**
 * ProviderConfig - Union type for provider configuration
 *
 * Accepts either the legacy ClaudeApiProfile or new ClaudeCompatibleProvider.
 * Both share the same connection settings structure.
 */
type ProviderConfig = ClaudeApiProfile | ClaudeCompatibleProvider;

/** SDK 0.3 effort levels accepted by Options.effort. */
type SdkEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ---------------------------------------------------------------------------
// Model capability table — the single source of truth for per-model behavior.
//
// All thinking/effort decisions and the public model catalog are derived from
// this table. Adding or changing a model is a one-line edit here, never a
// scattered set of `if (model.includes(...))` checks.
// ---------------------------------------------------------------------------

interface ModelCapability {
  /** Public id / SDK model string (same value — Claude needs no alias mapping). */
  id: string;
  /** Display name. */
  name: string;
  /** Context window in tokens. */
  contextWindow: number;
  /** Max output tokens (best-effort metadata for the catalog). */
  maxOutputTokens: number;
  /** Catalog tier. */
  tier: 'basic' | 'standard' | 'premium';
  /** Catalog description. */
  description: string;
  /**
   * Adaptive thinking: the model manages its own thinking budget. For these
   * models we NEVER set maxThinkingTokens (any thinkingLevel maps to omit).
   * Budget-based (Haiku) models map thinkingLevel -> maxThinkingTokens instead.
   */
  adaptiveThinking: boolean;
  /** Whether Options.effort is meaningful for this model. */
  supportsEffort: boolean;
  /** Marks default catalog model (exactly one). */
  default?: boolean;
  /** Marks model as deprecated (kept for back-compat; surfaced in description). */
  deprecated?: boolean;
}

/**
 * Capability table. Order here is the order surfaced by getAvailableModels().
 *
 * Per requirements:
 * - opus-4-8: default, 1M context, adaptive thinking, supports effort
 * - sonnet-4-6: 1M context, adaptive + extended thinking
 * - haiku-4-5-20251001: 200k context, extended thinking via budget only
 * - opus-4-6, sonnet-4-20250514: deprecated (noted in description)
 *
 * IMPORTANT: order matters for prefix-matching in getModelCapability().
 * More-specific (longer) ids must appear BEFORE shorter ids that would
 * otherwise match as a prefix. Example: 'claude-opus-4-8' must precede
 * 'claude-opus-4-6' so that a date-pinned 'claude-opus-4-8-20260101' hits
 * the opus-4-8 capability entry, not opus-4-6.
 */
const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tier: 'premium',
    description: 'Most capable Claude model. Adaptive thinking with effort control.',
    adaptiveThinking: true,
    supportsEffort: true,
    default: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    tier: 'standard',
    description: 'Balanced performance and cost. Adaptive and extended thinking.',
    adaptiveThinking: true,
    supportsEffort: false,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    tier: 'basic',
    description: 'Fastest Claude model. Extended thinking via token budget only.',
    adaptiveThinking: false,
    supportsEffort: false,
  },
  {
    // Fable 5 — added as a selectable model. Currently disabled (not GA), so it is
    // never wired as a default. Capabilities are provisional pending GA specs;
    // modeled on the current flagship (Opus 4.8).
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tier: 'premium',
    description: 'Next-generation Claude model. Provisional capabilities pending GA.',
    adaptiveThinking: true,
    supportsEffort: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tier: 'premium',
    description: 'Deprecated. Previous-generation Opus with adaptive thinking.',
    adaptiveThinking: true,
    supportsEffort: false,
    deprecated: true,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    tier: 'standard',
    description: 'Deprecated. Previous-generation Sonnet, balanced performance and cost.',
    adaptiveThinking: false,
    supportsEffort: false,
    deprecated: true,
  },
] as const;

/** Index for O(1) capability lookup by model id. */
const MODEL_CAPABILITY_BY_ID: ReadonlyMap<string, ModelCapability> = new Map(
  MODEL_CAPABILITIES.map((m) => [m.id, m])
);

/**
 * Resolve the capability descriptor for a model id.
 *
 * Defensive default for unknown/aliased models: treat as adaptive-thinking and
 * effort-incapable. This is the safest fallback — it avoids sending a thinking
 * budget the model may reject and avoids an effort value the model may not
 * support, while still letting the query run.
 */
function getModelCapability(model: string): ModelCapability {
  const exact = MODEL_CAPABILITY_BY_ID.get(model);
  if (exact) return exact;

  // Prefix match for date-pinned / aliased ids (e.g. an evolved opus-4-8 snapshot).
  for (const cap of MODEL_CAPABILITIES) {
    if (model.startsWith(cap.id)) return cap;
  }

  return {
    id: model,
    name: model,
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    tier: 'standard',
    description: 'Unknown Claude model (treated with conservative defaults).',
    adaptiveThinking: true, // omit maxThinkingTokens by default — safest
    supportsEffort: false,
  };
}

/**
 * Map AboardAI's ReasoningEffort onto the SDK's EffortLevel.
 *
 * SDK EffortLevel: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 * AboardAI ReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 *
 * Differences:
 * - 'none' and 'minimal' have no SDK counterpart. We clamp both to 'low'.
 *   Rationale: omitting effort entirely is NOT equivalent to "no effort" —
 *   for opus-4-8 the SDK default is 'high', which is the OPPOSITE of the
 *   user's intent when they chose 'none' or 'minimal'. 'low' is the closest
 *   available level.
 * - 'max' exists in the SDK EffortLevel but NOT in ReasoningEffort (as of this
 *   writing). If the type is extended, add it here — the default branch would
 *   silently swallow it otherwise.
 *
 * Exhaustive table (every ReasoningEffort value must appear as a case):
 *   none    → 'low'   (no SDK 'none'; see rationale above)
 *   minimal → 'low'   (no SDK 'minimal'; same rationale)
 *   low     → 'low'
 *   medium  → 'medium'
 *   high    → 'high'
 *   xhigh   → 'xhigh'
 *
 * Returns undefined for genuinely unrecognized / future values so the caller
 * omits the effort field rather than sending a bad value.
 */
function mapEffortToSdk(effort: ReasoningEffort | undefined): SdkEffortLevel | undefined {
  switch (effort) {
    // AboardAI-only levels — clamp to lowest SDK level (see JSDoc for rationale)
    case 'none':
    case 'minimal':
      return 'low';
    // Identity mappings
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort;
    // SDK also has 'max' but ReasoningEffort does not (yet). When/if added,
    // add an explicit case here so the exhaustive table stays accurate.
    default:
      return undefined;
  }
}

// System vars are always passed from process.env regardless of profile.
// Includes filesystem, locale, and temp directory vars that the Claude CLI
// needs internally for config resolution and temp file creation.
const SYSTEM_ENV_VARS = [
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  // Windows-specific vars required by Claude CLI for config/temp resolution
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'TEMP',
  'SystemRoot',
];

/**
 * Stream watchdog defaults (SDK 0.3 stream idle detection).
 *
 * These are written into the SDK subprocess env so the SDK aborts a silently
 * stalled stream, which the supervisor then resumes. They are DEFAULTS only —
 * if the caller's environment already sets either var, that value wins (the
 * caller's intent is preserved).
 */
const WATCHDOG_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: '90000',
};

/**
 * Check if the config is a ClaudeCompatibleProvider (new system)
 * by checking for the 'models' array property
 */
function isClaudeCompatibleProvider(config: ProviderConfig): config is ClaudeCompatibleProvider {
  return 'models' in config && Array.isArray(config.models);
}

/**
 * Build environment for the SDK with only explicitly allowed variables.
 *
 * Path A — ClaudeCompatibleProvider ("clean switch"): the subprocess env is
 * built entirely from explicit settings. Watchdog vars are seeded from
 * WATCHDOG_ENV_DEFAULTS and are NEVER read from process.env on this path —
 * a hostile process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS cannot shrink the
 * timeout and induce spurious watchdog trips that look like legitimate
 * provider behaviour.
 *
 * Path B — ClaudeApiProfile (legacy, profile-configured): clean switch for
 * non-system vars; watchdog defaults can be overridden by process.env (the
 * operator explicitly chose this profile, so operator intent wins).
 *
 * Path C — no provider ("direct Anthropic"): passes auth + endpoint vars from
 * process.env; watchdog defaults can be overridden by process.env.
 *
 * Supports both:
 * - ClaudeCompatibleProvider (new system with models[] array)
 * - ClaudeApiProfile (legacy system with modelMappings)
 *
 * @param providerConfig - Optional provider configuration for alternative endpoint
 * @param credentials - Optional credentials object for resolving 'credentials' apiKeySource
 */
function buildEnv(
  providerConfig?: ProviderConfig,
  credentials?: Credentials
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Seed watchdog defaults. For the ClaudeCompatibleProvider path these are
  // FIXED — process.env is never consulted for them (see docstring).
  // For other paths they are overridable via the final passthrough loop below.
  for (const [key, value] of Object.entries(WATCHDOG_ENV_DEFAULTS)) {
    env[key] = value;
  }

  if (providerConfig) {
    // Use provider configuration (clean switch - don't inherit non-system vars from process.env)
    logger.debug('[buildEnv] Using provider configuration:', {
      name: providerConfig.name,
      baseUrl: providerConfig.baseUrl,
      apiKeySource: providerConfig.apiKeySource ?? 'inline',
      isNewProvider: isClaudeCompatibleProvider(providerConfig),
    });

    // Resolve API key based on source strategy
    let apiKey: string | undefined;
    const source = providerConfig.apiKeySource ?? 'inline'; // Default to inline for backwards compat

    switch (source) {
      case 'inline':
        apiKey = providerConfig.apiKey;
        break;
      case 'env':
        apiKey = process.env.ANTHROPIC_API_KEY;
        break;
      case 'credentials':
        apiKey = credentials?.apiKeys?.anthropic;
        break;
    }

    // Warn if no API key found
    if (!apiKey) {
      logger.warn(`No API key found for provider "${providerConfig.name}" with source "${source}"`);
    }

    // Authentication
    if (providerConfig.useAuthToken) {
      env['ANTHROPIC_AUTH_TOKEN'] = apiKey;
    } else {
      env['ANTHROPIC_API_KEY'] = apiKey;
    }

    // Endpoint configuration
    env['ANTHROPIC_BASE_URL'] = providerConfig.baseUrl;
    logger.debug(`[buildEnv] Set ANTHROPIC_BASE_URL to: ${providerConfig.baseUrl}`);

    if (providerConfig.timeoutMs) {
      env['API_TIMEOUT_MS'] = String(providerConfig.timeoutMs);
    }

    // Model mappings - only for legacy ClaudeApiProfile
    // For ClaudeCompatibleProvider, the model is passed directly (no mapping needed)
    if (!isClaudeCompatibleProvider(providerConfig) && providerConfig.modelMappings) {
      if (providerConfig.modelMappings.haiku) {
        env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = providerConfig.modelMappings.haiku;
      }
      if (providerConfig.modelMappings.sonnet) {
        env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = providerConfig.modelMappings.sonnet;
      }
      if (providerConfig.modelMappings.opus) {
        env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = providerConfig.modelMappings.opus;
      }
    }

    // Traffic control
    if (providerConfig.disableNonessentialTraffic) {
      env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
    }
  } else {
    // Use direct Anthropic API - pass through credentials or environment variables
    // This supports:
    // 1. API Key mode: ANTHROPIC_API_KEY from credentials (UI settings) or env
    // 2. Claude Max plan: Uses CLI OAuth auth (SDK handles this automatically)
    // 3. Custom endpoints via ANTHROPIC_BASE_URL env var (backward compatibility)
    //
    // Priority: credentials file (UI settings) -> environment variable
    // Note: Only auth and endpoint vars are passed. Model mappings and traffic
    // control are NOT passed (those require a profile for explicit configuration).
    if (credentials?.apiKeys?.anthropic) {
      env['ANTHROPIC_API_KEY'] = credentials.apiKeys.anthropic;
    } else if (process.env.ANTHROPIC_API_KEY) {
      env['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
    }
    // If using Claude Max plan via CLI auth, the SDK handles auth automatically
    // when no API key is provided. We don't set ANTHROPIC_AUTH_TOKEN here
    // unless it was explicitly set in process.env (rare edge case).
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      env['ANTHROPIC_AUTH_TOKEN'] = process.env.ANTHROPIC_AUTH_TOKEN;
    }
    // Pass through ANTHROPIC_BASE_URL if set in environment (backward compatibility)
    if (process.env.ANTHROPIC_BASE_URL) {
      env['ANTHROPIC_BASE_URL'] = process.env.ANTHROPIC_BASE_URL;
    }
  }

  // Always pass system vars from process.env (PATH, HOME, APPDATA, etc.).
  // For non-compat paths also allow process.env to override the watchdog
  // defaults seeded above; for the ClaudeCompatibleProvider path the watchdog
  // vars are intentionally excluded — their fixed defaults must hold.
  const cleanSwitchPath = providerConfig ? isClaudeCompatibleProvider(providerConfig) : false;
  const extraKeys = cleanSwitchPath
    ? SYSTEM_ENV_VARS // compat: system vars only — no watchdog override
    : [...SYSTEM_ENV_VARS, ...Object.keys(WATCHDOG_ENV_DEFAULTS)]; // others: watchdog overridable

  for (const key of extraKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}

export class ClaudeProvider extends BaseProvider {
  getName(): string {
    return 'claude';
  }

  /**
   * Execute a query using Claude Agent SDK.
   *
   * Reliability contract:
   * - Forwards every SDK message verbatim, including the earliest init system
   *   message (which carries session_id top-level) and result messages
   *   (including error results) — the supervisor reads these.
   * - Drains the stream to completion; never breaks on the result message,
   *   because SDK 0.3 may emit trailing messages after it.
   * - Resumes whenever sdkSessionId is provided (no conversationHistory gate).
   */
  async *executeQuery(options: ExecuteOptions): AsyncGenerator<ProviderMessage> {
    // Validate that model doesn't have a provider prefix
    // AgentService should strip prefixes before passing to providers
    // Claude doesn't use a provider prefix, so we don't need to specify an expected provider
    validateBareModelId(options.model, 'ClaudeProvider');

    const {
      prompt,
      model,
      cwd,
      systemPrompt,
      maxTurns = 1000,
      allowedTools,
      abortController,
      sdkSessionId,
      thinkingLevel,
      reasoningEffort,
      claudeApiProfile,
      claudeCompatibleProvider,
      credentials,
    } = options;

    // Determine which provider config to use
    // claudeCompatibleProvider takes precedence over claudeApiProfile
    const providerConfig = claudeCompatibleProvider || claudeApiProfile;

    // Resolve per-model capabilities from the single capability table.
    const capability = getModelCapability(model);

    // Build thinking configuration from the capability flag (centralized rule):
    // - Adaptive-thinking models (opus-4-8, sonnet-4-6, opus-4-6): NEVER set
    //   maxThinkingTokens — the model manages its own budget.
    // - Budget models (haiku-4-5): derive maxThinkingTokens from thinkingLevel.
    const maxThinkingTokens = capability.adaptiveThinking
      ? undefined
      : getThinkingTokenBudget(thinkingLevel);

    // Build effort configuration (centralized rule): only for effort-capable
    // models, and only when the caller supplied a reasoningEffort.
    const sdkEffort = capability.supportsEffort ? mapEffortToSdk(reasoningEffort) : undefined;

    // Build Claude SDK options
    const sdkOptions: Options = {
      model,
      systemPrompt,
      maxTurns,
      cwd,
      // Pass only explicitly allowed environment variables to SDK
      // When a provider is active, uses provider settings (clean switch)
      // When no provider, uses direct Anthropic API (from process.env or CLI OAuth)
      // Watchdog defaults are seeded here (overridable via process.env).
      env: buildEnv(providerConfig, credentials),
      // Pass through allowedTools if provided by caller (decided by sdk-options.ts)
      ...(allowedTools && { allowedTools }),
      // Restrict available built-in tools if specified (tools: [] disables all tools)
      ...(options.tools && { tools: options.tools }),
      // AUTONOMOUS MODE: Always bypass permissions for fully autonomous operation
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      // Resume existing SDK session whenever a session id is present.
      // The supervisor resumes WITHOUT replaying conversationHistory, so the
      // old `&& conversationHistory.length > 0` gate is removed — resume must
      // trigger on sdkSessionId alone.
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
      // Forward settingSources for CLAUDE.md file loading
      ...(options.settingSources && { settingSources: options.settingSources }),
      // Forward MCP servers configuration
      ...(options.mcpServers && { mcpServers: options.mcpServers }),
      // Extended thinking configuration (budget models only — see capability table)
      ...(maxThinkingTokens && { maxThinkingTokens }),
      // Reasoning effort (effort-capable models only — opus-4-8)
      ...(sdkEffort && { effort: sdkEffort }),
      // Subagents configuration for specialized task delegation
      ...(options.agents && { agents: options.agents }),
      // Pass through outputFormat for structured JSON outputs
      ...(options.outputFormat && { outputFormat: options.outputFormat }),
    };

    // Build prompt payload
    let promptPayload: string | AsyncIterable<SDKUserMessage>;

    if (Array.isArray(prompt)) {
      // Multi-part prompt (with images)
      promptPayload = (async function* () {
        const multiPartPrompt: SDKUserMessage = {
          type: 'user' as const,
          session_id: sdkSessionId || '',
          message: {
            role: 'user' as const,
            content: prompt as ContentBlockParam[],
          },
          parent_tool_use_id: null,
        };
        yield multiPartPrompt;
      })();
    } else {
      // Simple text prompt
      promptPayload = prompt;
    }

    // Log the environment being passed to the SDK for debugging
    const envForSdk = sdkOptions.env as Record<string, string | undefined>;
    logger.debug('[ClaudeProvider] SDK Configuration:', {
      model: sdkOptions.model,
      baseUrl: envForSdk?.['ANTHROPIC_BASE_URL'] || '(default Anthropic API)',
      hasApiKey: !!envForSdk?.['ANTHROPIC_API_KEY'],
      hasAuthToken: !!envForSdk?.['ANTHROPIC_AUTH_TOKEN'],
      providerName: providerConfig?.name || '(direct Anthropic)',
      maxTurns: sdkOptions.maxTurns,
      maxThinkingTokens: sdkOptions.maxThinkingTokens,
      effort: sdkOptions.effort,
      resume: !!sdkOptions.resume,
      watchdog: envForSdk?.['CLAUDE_ENABLE_STREAM_WATCHDOG'],
    });

    // Execute via Claude Agent SDK
    try {
      const stream = query({ prompt: promptPayload, options: sdkOptions });

      // Drain the stream to completion. SDK 0.3 can emit trailing messages
      // (e.g. prompt suggestions, API retry notices) AFTER the result message,
      // so we never break on a result — we forward everything and let the
      // for-await loop end naturally when the generator is exhausted.
      //
      // Messages are forwarded verbatim: session_id (from the init system
      // message and result messages) and result error fields (is_error,
      // api_error_status, errors) reach the supervisor unchanged.
      for await (const msg of stream) {
        yield msg as ProviderMessage;
      }
    } catch (error) {
      // Thrown errors are fatal-stream / startup failures (subprocess spawn,
      // network reset before any message, etc). Operational errors arrive as
      // result messages and are NOT thrown — those flow through the loop above.
      //
      // Enhance error with user-friendly message and classification, preserving
      // originalError / type / retryAfter for the supervisor and consumers.
      const errorInfo = classifyError(error);
      const userMessage = getUserFriendlyErrorMessage(error);

      logger.error('executeQuery() error during execution:', {
        type: errorInfo.type,
        message: errorInfo.message,
        isRateLimit: errorInfo.isRateLimit,
        retryAfter: errorInfo.retryAfter,
        stack: (error as Error).stack,
      });

      // Build enhanced error message with additional guidance for rate limits.
      //
      // The supervisor (ProviderSupervisor, Task 7 / commit 1673f83) reads the
      // structured `err.retryAfter` property directly (S12) — it no longer
      // parses the message text for a delay. The old `(retry after Ns)` suffix
      // that used to feed a text-regex parser is therefore redundant and would
      // double-render the wait time in UI messages. The suffix is omitted; the
      // structured `retryAfter` set below remains the authoritative channel.
      let message: string;
      if (errorInfo.isRateLimit) {
        message = `${userMessage}\n\nTip: If you're running multiple features in auto-mode, consider reducing concurrency (maxConcurrency setting) to avoid hitting rate limits.`;
      } else {
        message = userMessage;
      }

      const enhancedError = new Error(message) as Error & {
        originalError: unknown;
        type: string;
        retryAfter?: number;
      };
      enhancedError.originalError = error;
      enhancedError.type = errorInfo.type;

      if (errorInfo.isRateLimit) {
        enhancedError.retryAfter = errorInfo.retryAfter;
      }

      throw enhancedError;
    }
  }

  /**
   * Detect Claude SDK installation (always available via npm)
   */
  async detectInstallation(): Promise<InstallationStatus> {
    // Claude SDK is always available since it's a dependency
    // Check all four supported auth methods, mirroring the logic in buildEnv():
    // 1. ANTHROPIC_API_KEY environment variable
    // 2. ANTHROPIC_AUTH_TOKEN environment variable
    // 3. credentials?.apiKeys?.anthropic (credentials file, checked via platform indicators)
    // 4. Claude Max CLI OAuth (SDK handles this automatically; detected via getClaudeAuthIndicators)
    const hasEnvApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasEnvAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;

    // Check credentials file and CLI OAuth indicators (same sources used by buildEnv)
    let hasCredentialsApiKey = false;
    let hasCliOAuth = false;
    try {
      const indicators = await getClaudeAuthIndicators();
      hasCredentialsApiKey = !!indicators.credentials?.hasApiKey;
      hasCliOAuth = !!(
        indicators.credentials?.hasOAuthToken ||
        indicators.hasStatsCacheWithActivity ||
        (indicators.hasSettingsFile && indicators.hasProjectsSessions)
      );
    } catch {
      // If we can't check indicators, fall back to env vars only
    }

    const hasApiKey = hasEnvApiKey || hasCredentialsApiKey;
    const authenticated = hasEnvApiKey || hasEnvAuthToken || hasCredentialsApiKey || hasCliOAuth;

    const status: InstallationStatus = {
      installed: true,
      method: 'sdk',
      hasApiKey,
      authenticated,
    };

    return status;
  }

  /**
   * Get available Claude models.
   *
   * Derived from MODEL_CAPABILITIES — the same table that drives thinking/effort
   * behavior — so the catalog and runtime behavior can never drift apart.
   */
  getAvailableModels(): ModelDefinition[] {
    const staticModels = MODEL_CAPABILITIES.map((cap) => ({
      id: cap.id,
      name: cap.name,
      modelString: cap.id,
      provider: 'anthropic',
      description: cap.description,
      contextWindow: cap.contextWindow,
      maxOutputTokens: cap.maxOutputTokens,
      supportsVision: true,
      supportsTools: true,
      tier: cap.tier,
      ...(cap.default ? { default: true } : {}),
      // hasReasoning surfaces effort/adaptive-thinking capability to consumers.
      hasReasoning: cap.supportsEffort || cap.adaptiveThinking,
    })) satisfies ModelDefinition[];

    // Append models discovered from the Anthropic API that the table does not
    // list. Capabilities come from the nearest table entry (prefix match) or
    // the conservative defaults, so runtime behavior stays consistent.
    const discovered = getCachedClaudeModels();
    if (!discovered) return staticModels;

    const knownIds = new Set(staticModels.map((m) => m.id));
    const extra: ModelDefinition[] = discovered
      .filter((m) => !knownIds.has(m.id))
      .map((m) => {
        const cap = getModelCapability(m.id);
        return {
          id: m.id,
          name: m.displayName,
          modelString: m.id,
          provider: 'anthropic',
          description:
            cap.id === m.id
              ? cap.description
              : `Discovered from the Anthropic API. ${cap.description}`,
          contextWindow: cap.contextWindow,
          maxOutputTokens: cap.maxOutputTokens,
          supportsVision: true,
          supportsTools: true,
          tier: cap.tier,
          hasReasoning: cap.supportsEffort || cap.adaptiveThinking,
        };
      });

    return [...staticModels, ...extra];
  }

  /**
   * Refresh the model list from the Anthropic API.
   * Falls back to the static table when no API key is available.
   */
  async refreshModels(apiKey?: string): Promise<ModelDefinition[]> {
    await refreshClaudeModels(apiKey ?? process.env.ANTHROPIC_API_KEY);
    return this.getAvailableModels();
  }

  hasCachedModels(): boolean {
    return hasCachedClaudeModels();
  }

  clearModelCache(): void {
    clearClaudeModelCache();
  }

  /**
   * Check if the provider supports a specific feature
   */
  supportsFeature(feature: string): boolean {
    const supportedFeatures = ['tools', 'text', 'vision', 'thinking'];
    return supportedFeatures.includes(feature);
  }
}
