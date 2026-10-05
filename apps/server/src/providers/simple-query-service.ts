/**
 * Simple Query Service - Simplified interface for basic AI queries
 *
 * Use this for routes that need simple text responses without
 * complex event handling. This service abstracts away the provider
 * selection and streaming details, providing a clean interface
 * for common query patterns.
 *
 * Benefits:
 * - No direct SDK imports needed in route files
 * - Consistent provider routing based on model
 * - Automatic text extraction from streaming responses
 * - Structured output support for JSON schema responses
 * - Eliminates duplicate extractTextFromStream() functions
 */

import { ProviderFactory } from './provider-factory.js';
import type { BaseProvider } from './base-provider.js';
import {
  accountKey,
  isModelAccessError,
  noteAccountFailure,
  nextFallback,
  type FallbackContinuation,
} from './model-fallback.js';
import type {
  ThinkingLevel,
  ReasoningEffort,
  ClaudeApiProfile,
  ClaudeCompatibleProvider,
  Credentials,
  ExecuteOptions,
} from '@aboardai/types';
import { stripProviderPrefix } from '@aboardai/types';

/**
 * Options for simple query execution
 */
export interface SimpleQueryOptions {
  /** The prompt to send to the AI (can be text or multi-part content) */
  prompt: string | Array<{ type: string; text?: string; source?: object }>;
  /** Model to use (with or without provider prefix) */
  model?: string;
  /** Working directory for the query */
  cwd: string;
  /** System prompt (combined with user prompt for some providers) */
  systemPrompt?: string;
  /** Maximum turns for agentic operations (default: 1) */
  maxTurns?: number;
  /** Tools to allow (default: [] for simple queries) */
  allowedTools?: string[];
  /** Abort controller for cancellation */
  abortController?: AbortController;
  /** Structured output format for JSON responses */
  outputFormat?: {
    type: 'json_schema';
    schema: Record<string, unknown>;
  };
  /** Thinking level for Claude models */
  thinkingLevel?: ThinkingLevel;
  /** Reasoning effort for Codex/OpenAI models */
  reasoningEffort?: ReasoningEffort;
  /** If true, runs in read-only mode (no file writes) */
  readOnly?: boolean;
  /** Setting sources for CLAUDE.md loading */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /**
   * Active Claude API profile for alternative endpoint configuration
   * @deprecated Use claudeCompatibleProvider instead
   */
  claudeApiProfile?: ClaudeApiProfile;
  /**
   * Claude-compatible provider for alternative endpoint configuration.
   * Takes precedence over claudeApiProfile if both are set.
   */
  claudeCompatibleProvider?: ClaudeCompatibleProvider;
  /** Credentials for resolving 'credentials' apiKeySource in Claude API profiles/providers */
  credentials?: Credentials;
  /** Fail instead of moving to another model when this one is out of usage (access probes). */
  noFallback?: boolean;
}

/**
 * Result from a simple query
 */
export interface SimpleQueryResult {
  /** The accumulated text response */
  text: string;
  /** Structured output if outputFormat was specified and provider supports it */
  structured_output?: Record<string, unknown>;
}

/**
 * Options for streaming query execution
 */
export interface StreamingQueryOptions extends SimpleQueryOptions {
  /** Callback for each text chunk received */
  onText?: (text: string) => void;
  /** Callback for tool use events */
  onToolUse?: (tool: string, input: unknown) => void;
  /** Callback for thinking blocks (if available) */
  onThinking?: (thinking: string) => void;
}

/**
 * Default model to use when none specified
 */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Run a query, moving to the next account with usage when the model's account
 * is out of usage, unauthenticated, or unavailable.
 */
async function runWithModelFallback<T>(
  provider: BaseProvider,
  providerOptions: ExecuteOptions,
  allowFallback: boolean,
  run: (provider: BaseProvider, providerOptions: ExecuteOptions) => Promise<T>,
  continuation: () => FallbackContinuation
): Promise<T> {
  const tried = new Set<string>();
  const originalOptions = providerOptions;
  let account = accountKey(provider, providerOptions);
  while (true) {
    tried.add(account);
    try {
      return await run(provider, providerOptions);
    } catch (error) {
      if (
        !allowFallback ||
        process.env.ABOARDAI_MOCK_AGENT === 'true' ||
        providerOptions.abortController?.signal.aborted ||
        !isModelAccessError(error)
      ) {
        throw error;
      }
      noteAccountFailure(account, error);
      const next = await nextFallback(originalOptions, tried, continuation());
      if (!next) throw error;
      provider = next.provider;
      providerOptions = next.options;
      account = next.account;
    }
  }
}

/**
 * Execute a simple query and return the text result
 *
 * Use this for simple, non-streaming queries where you just need
 * the final text response. For more complex use cases with progress
 * callbacks, use streamingQuery() instead.
 *
 * @example
 * ```typescript
 * const result = await simpleQuery({
 *   prompt: 'Generate a title for: user authentication',
 *   cwd: process.cwd(),
 *   systemPrompt: 'You are a title generator...',
 *   maxTurns: 1,
 *   allowedTools: [],
 * });
 * console.log(result.text); // "Add user authentication"
 * ```
 */
export async function simpleQuery(options: SimpleQueryOptions): Promise<SimpleQueryResult> {
  const model = options.model || DEFAULT_MODEL;
  const provider = ProviderFactory.getProviderForModel(model);
  const bareModel = stripProviderPrefix(model);

  // Build provider options
  const providerOptions: ExecuteOptions = {
    prompt: options.prompt,
    model: bareModel,
    originalModel: model,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    maxTurns: options.maxTurns ?? 1,
    allowedTools: options.allowedTools ?? [],
    tools: options.allowedTools ?? [],
    abortController: options.abortController,
    outputFormat: options.outputFormat,
    thinkingLevel: options.thinkingLevel,
    reasoningEffort: options.reasoningEffort,
    readOnly: options.readOnly,
    settingSources: options.settingSources,
    claudeApiProfile: options.claudeApiProfile, // Legacy: Pass active Claude API profile for alternative endpoint configuration
    claudeCompatibleProvider: options.claudeCompatibleProvider, // New: Pass Claude-compatible provider (takes precedence)
    credentials: options.credentials, // Pass credentials for resolving 'credentials' apiKeySource
  };

  // A tool call may have changed files before an access failure.
  let workStarted = false;
  return runWithModelFallback(
    provider,
    providerOptions,
    !options.noFallback,
    async (provider, providerOptions) => {
      let responseText = '';
      let structuredOutput: Record<string, unknown> | undefined;
      for await (const msg of provider.executeQuery(providerOptions)) {
        // Handle error messages
        if (msg.type === 'error') {
          const errorMessage = msg.error || 'Provider returned an error';
          throw new Error(errorMessage);
        }

        // Extract text from assistant messages
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              responseText += block.text;
            } else if (block.type === 'tool_use') {
              workStarted = true;
            }
          }
        }

        // Handle result messages
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            // Use result text if longer than accumulated text
            if (msg.result && msg.result.length > responseText.length) {
              responseText = msg.result;
            }
            // Capture structured output if present
            if (msg.structured_output) {
              structuredOutput = msg.structured_output;
            }
          } else if (msg.subtype === 'error_max_turns') {
            if (!responseText.trim()) {
              throw new Error('Provider ended before producing text (error_max_turns)');
            }
            // Max turns reached after producing text - return the partial response.
            break;
          } else if (msg.subtype === 'error_max_structured_output_retries') {
            throw new Error('Could not produce valid structured output after retries');
          }
        }
      }

      return { text: responseText, structured_output: structuredOutput };
    },
    () => ({ workStarted })
  );
}

/**
 * Execute a streaming query with event callbacks
 *
 * Use this for queries where you need real-time progress updates,
 * such as when displaying streaming output to a user.
 *
 * @example
 * ```typescript
 * const result = await streamingQuery({
 *   prompt: 'Analyze this project and suggest improvements',
 *   cwd: '/path/to/project',
 *   maxTurns: 250,
 *   allowedTools: ['Read', 'Glob', 'Grep'],
 *   onText: (text) => emitProgress(text),
 *   onToolUse: (tool, input) => emitToolUse(tool, input),
 * });
 * ```
 */
export async function streamingQuery(options: StreamingQueryOptions): Promise<SimpleQueryResult> {
  const model = options.model || DEFAULT_MODEL;
  const provider = ProviderFactory.getProviderForModel(model);
  const bareModel = stripProviderPrefix(model);

  // Build provider options
  const providerOptions: ExecuteOptions = {
    prompt: options.prompt,
    model: bareModel,
    originalModel: model,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    maxTurns: options.maxTurns ?? 250,
    allowedTools: options.allowedTools ?? ['Read', 'Glob', 'Grep'],
    abortController: options.abortController,
    outputFormat: options.outputFormat,
    thinkingLevel: options.thinkingLevel,
    reasoningEffort: options.reasoningEffort,
    readOnly: options.readOnly,
    settingSources: options.settingSources,
    claudeApiProfile: options.claudeApiProfile, // Legacy: Pass active Claude API profile for alternative endpoint configuration
    claudeCompatibleProvider: options.claudeCompatibleProvider, // New: Pass Claude-compatible provider (takes precedence)
    credentials: options.credentials, // Pass credentials for resolving 'credentials' apiKeySource
  };

  // Text already streamed by a model that then ran out of usage. A backup model
  // continues the work, so the caller receives both parts.
  let carriedText = '';
  let streamedText = '';
  let workStarted = false;
  return runWithModelFallback(
    provider,
    providerOptions,
    !options.noFallback,
    async (provider, providerOptions) => {
      carriedText += streamedText;
      streamedText = '';
      let responseText = '';
      let structuredOutput: Record<string, unknown> | undefined;
      for await (const msg of provider.executeQuery(providerOptions)) {
        // Handle error messages
        if (msg.type === 'error') {
          const errorMessage = msg.error || 'Provider returned an error';
          throw new Error(errorMessage);
        }

        // Extract content from assistant messages
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              responseText += block.text;
              streamedText += block.text;
              options.onText?.(block.text);
            } else if (block.type === 'tool_use' && block.name) {
              workStarted = true;
              options.onToolUse?.(block.name, block.input);
            } else if (block.type === 'thinking' && block.thinking) {
              options.onThinking?.(block.thinking);
            }
          }
        }

        // Handle result messages
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            // Use result text if longer than accumulated text
            if (msg.result && msg.result.length > responseText.length) {
              responseText = msg.result;
            }
            // Capture structured output if present
            if (msg.structured_output) {
              structuredOutput = msg.structured_output;
            }
          } else if (msg.subtype === 'error_max_turns') {
            // Max turns reached - return what we have
            break;
          } else if (msg.subtype === 'error_max_structured_output_retries') {
            throw new Error('Could not produce valid structured output after retries');
          }
        }
      }

      return { text: carriedText + responseText, structured_output: structuredOutput };
    },
    () => ({ workStarted, partialResponse: carriedText + streamedText })
  );
}
