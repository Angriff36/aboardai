import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeProvider } from '@/providers/claude-provider.js';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { collectAsyncGenerator } from '../../utils/helpers.js';

vi.mock('@anthropic-ai/claude-agent-sdk');

vi.mock('@aboardai/platform', () => ({
  getClaudeAuthIndicators: vi.fn().mockResolvedValue({
    hasCredentialsFile: false,
    hasSettingsFile: false,
    hasStatsCacheWithActivity: false,
    hasProjectsSessions: false,
    credentials: null,
    checks: {},
  }),
}));

/** Helper: stub sdk.query() to return an async generator over `messages`. */
function mockQuery(messages: unknown[]): void {
  vi.mocked(sdk.query).mockReturnValue(
    (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })() as ReturnType<typeof sdk.query>
  );
}

/** Helper: stub sdk.query() to throw `error` immediately (no messages). */
function mockQueryThrows(error: Error): void {
  vi.mocked(sdk.query).mockReturnValue(
    (async function* () {
      // yield* over an empty stream keeps this a valid generator (and satisfies
      // require-yield) while still throwing on the first .next().
      yield* [] as unknown[];
      throw error;
    })() as ReturnType<typeof sdk.query>
  );
}

/** Helper: return the options passed to the most recent sdk.query() call. */
function lastQueryOptions(): Record<string, unknown> {
  const calls = vi.mocked(sdk.query).mock.calls;
  return calls[calls.length - 1][0].options as unknown as Record<string, unknown>;
}

describe('claude-provider.ts', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG;
    delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS;
  });

  describe('getName', () => {
    it("should return 'claude' as provider name", () => {
      expect(provider.getName()).toBe('claude');
    });
  });

  describe('executeQuery', () => {
    it('should execute simple text query', async () => {
      mockQuery([
        { type: 'text', text: 'Response 1' },
        { type: 'text', text: 'Response 2' },
      ]);

      const generator = provider.executeQuery({
        prompt: 'Hello',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      const results = await collectAsyncGenerator(generator);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ type: 'text', text: 'Response 1' });
      expect(results[1]).toEqual({ type: 'text', text: 'Response 2' });
    });

    it('should pass correct options to SDK', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test prompt',
        model: 'claude-opus-4-8',
        cwd: '/test/dir',
        systemPrompt: 'You are helpful',
        maxTurns: 10,
        allowedTools: ['Read', 'Write'],
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        options: expect.objectContaining({
          model: 'claude-opus-4-8',
          systemPrompt: 'You are helpful',
          maxTurns: 10,
          cwd: '/test/dir',
          allowedTools: ['Read', 'Write'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        }),
      });
    });

    it('should not include allowedTools when not specified (caller decides via sdk-options)', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test',
        options: expect.not.objectContaining({
          allowedTools: expect.anything(),
        }),
      });
    });

    it('should pass abortController if provided', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const abortController = new AbortController();

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        abortController,
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test',
        options: expect.objectContaining({
          abortController,
        }),
      });
    });

    // -------------------------------------------------------------------------
    // Session capture + resume (the supervisor resumes WITHOUT history)
    // -------------------------------------------------------------------------

    it('should pass resume when sdkSessionId provided WITHOUT conversationHistory', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Current message',
        model: 'claude-opus-4-8',
        cwd: '/test',
        // No conversationHistory — the supervisor resumes on session id alone.
        sdkSessionId: 'sess-resume-1',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ resume: 'sess-resume-1' });
    });

    it('should pass resume when sdkSessionId provided WITH conversationHistory', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Current message',
        model: 'claude-opus-4-8',
        cwd: '/test',
        conversationHistory: [
          { role: 'user', content: 'Previous message' },
          { role: 'assistant', content: 'Previous response' },
        ],
        sdkSessionId: 'sess-resume-2',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ resume: 'sess-resume-2' });
    });

    it('should NOT pass resume when sdkSessionId is absent', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Fresh start',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('resume');
    });

    it('should forward init system message carrying session_id verbatim', async () => {
      const initMsg = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-from-init',
        model: 'claude-opus-4-8',
      };
      mockQuery([
        initMsg,
        { type: 'result', subtype: 'success', result: 'done', session_id: 'sess-from-init' },
      ]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      const results = await collectAsyncGenerator(generator);

      // First forwarded message is the init system message with session_id intact.
      expect(results[0]).toMatchObject({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-from-init',
      });
    });

    // -------------------------------------------------------------------------
    // Drain to completion (trailing messages after result)
    // -------------------------------------------------------------------------

    it('should drain trailing messages AFTER the result message (no early break)', async () => {
      mockQuery([
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'work' }] },
        },
        { type: 'result', subtype: 'success', result: 'done', session_id: 's' },
        // SDK 0.3 can emit messages after result (e.g. prompt suggestion / api retry).
        { type: 'prompt_suggestion', suggestion: 'next?' },
      ]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      const results = await collectAsyncGenerator(generator);

      // All 3 messages forwarded — including the one after the result.
      expect(results).toHaveLength(3);
      expect(results[2]).toMatchObject({ type: 'prompt_suggestion' });
    });

    // -------------------------------------------------------------------------
    // Result-error surfacing — forwarded as-is, NOT thrown
    // -------------------------------------------------------------------------

    it('should forward error result messages as-is (is_error / api_error_status preserved)', async () => {
      const errorResult = {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 529,
        session_id: 's-err',
      };
      mockQuery([errorResult]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      // Does NOT throw — the supervisor decides retries from the forwarded result.
      const results = await collectAsyncGenerator(generator);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 529,
      });
    });

    it('should handle array prompt (with images)', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const arrayPrompt = [
        { type: 'text', text: 'Describe this' },
        { type: 'image', source: { type: 'base64', data: '...' } },
      ];

      const generator = provider.executeQuery({
        prompt: arrayPrompt as never,
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      // Should pass an async generator as prompt for array inputs
      const callArgs = vi.mocked(sdk.query).mock.calls[0][0];
      expect(typeof callArgs.prompt).not.toBe('string');
    });

    it('should use maxTurns default of 1000', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ maxTurns: 1000 });
    });

    it('should handle thrown SDK errors and rethrow enhanced (preserving originalError/type)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const testError = new Error('SDK execution failed');

      mockQueryThrows(testError);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      let caught: (Error & { originalError?: unknown; type?: string }) | undefined;
      try {
        await collectAsyncGenerator(generator);
      } catch (e) {
        caught = e as Error & { originalError?: unknown; type?: string };
      }

      expect(caught).toBeDefined();
      // Enhanced error preserves the original and a classification type.
      expect(caught?.originalError).toBe(testError);
      expect(typeof caught?.type).toBe('string');

      // Should log error with classification info (via logger)
      const errorCall = consoleErrorSpy.mock.calls[0];
      expect(errorCall[0]).toMatch(/ERROR.*\[ClaudeProvider\]/);
      expect(errorCall[1]).toBe('executeQuery() error during execution:');
      expect(errorCall[2]).toMatchObject({
        type: expect.any(String),
        message: 'SDK execution failed',
        isRateLimit: false,
        stack: expect.stringContaining('Error: SDK execution failed'),
      });

      consoleErrorSpy.mockRestore();
    });

    it('should attach retryAfter on rate-limit thrown errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockQueryThrows(new Error('429 rate limit exceeded, please wait 5 seconds before retrying'));

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      let caught: (Error & { type?: string; retryAfter?: number }) | undefined;
      try {
        await collectAsyncGenerator(generator);
      } catch (e) {
        caught = e as Error & { type?: string; retryAfter?: number };
      }

      expect(caught?.type).toBe('rate_limit');
      // Structured retryAfter (in seconds) must be set so the supervisor can
      // read it directly without text parsing (S12 structured path).
      expect(caught?.retryAfter).toBe(5);
      // Message should include the auto-mode concurrency tip for rate limits.
      expect(caught?.message).toMatch(/maxConcurrency/i);
      // Message must NOT contain a `(retry after Ns)` text suffix — the
      // supervisor reads the structured property; the suffix is redundant and
      // would double-render the wait time in UI messages.
      expect(caught?.message).not.toMatch(/\(retry after \d+s\)/);

      consoleErrorSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Thinking / effort rules — driven by the model capability table
  // ---------------------------------------------------------------------------

  describe('thinking and effort rules', () => {
    it('adaptive model (opus-4-8): NEVER sets maxThinkingTokens, even with thinkingLevel', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        thinkingLevel: 'high',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('maxThinkingTokens');
    });

    it('adaptive model (sonnet-4-6): NEVER sets maxThinkingTokens', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-sonnet-4-6',
        cwd: '/test',
        thinkingLevel: 'ultrathink',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('maxThinkingTokens');
    });

    it('budget model (haiku-4-5): sets maxThinkingTokens from thinkingLevel', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-haiku-4-5-20251001',
        cwd: '/test',
        thinkingLevel: 'high', // -> 16000 per THINKING_TOKEN_BUDGET
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ maxThinkingTokens: 16000 });
    });

    it('budget model (haiku-4-5): omits maxThinkingTokens when thinkingLevel is none/undefined', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-haiku-4-5-20251001',
        cwd: '/test',
        // no thinkingLevel
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('maxThinkingTokens');
    });

    it('effort model (opus-4-8): passes effort through to SDK', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        reasoningEffort: 'high',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ effort: 'high' });
    });

    it('effort model (opus-4-8): maps unsupported ReasoningEffort (none/minimal) down to lowest SDK level', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        reasoningEffort: 'minimal', // SDK has no 'minimal' -> clamp to 'low'
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ effort: 'low' });
    });

    it("[Fix2] effort model (opus-4-8): 'none' maps to 'low' — omitting effort would leave SDK at its default 'high' (wrong direction)", async () => {
      // The SDK default for opus-4-8 is 'high'. When the user chooses 'none'
      // they want minimal effort, not maximal — so we clamp to 'low' rather
      // than omitting the field (which would silently use 'high').
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        reasoningEffort: 'none',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).toMatchObject({ effort: 'low' });
    });

    it('[Fix2] effort model (opus-4-8): exhaustive — all ReasoningEffort values produce a defined SDK effort', async () => {
      const cases: Array<[string, string]> = [
        ['none', 'low'],
        ['minimal', 'low'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
      ];

      for (const [input, expected] of cases) {
        mockQuery([{ type: 'text', text: 'test' }]);

        const generator = provider.executeQuery({
          prompt: 'Test',
          model: 'claude-opus-4-8',
          cwd: '/test',
          reasoningEffort: input as never,
        });

        await collectAsyncGenerator(generator);

        expect(lastQueryOptions()).toMatchObject(
          { effort: expected },
          // @ts-expect-error vitest overload; message only shown on failure
          `reasoningEffort '${input}' should map to SDK effort '${expected}'`
        );
      }
    });

    it('non-effort model (sonnet-4-6): does NOT pass effort even when requested', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-sonnet-4-6',
        cwd: '/test',
        reasoningEffort: 'high',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('effort');
    });

    it('effort model (opus-4-8): omits effort when no reasoningEffort supplied', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(lastQueryOptions()).not.toHaveProperty('effort');
    });
  });

  describe('detectInstallation', () => {
    it('should return installed with SDK method', async () => {
      const result = await provider.detectInstallation();

      expect(result.installed).toBe(true);
      expect(result.method).toBe('sdk');
    });

    it('should detect ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const result = await provider.detectInstallation();

      expect(result.hasApiKey).toBe(true);
      expect(result.authenticated).toBe(true);
    });

    it('should return hasApiKey false when no keys present', async () => {
      const result = await provider.detectInstallation();

      expect(result.hasApiKey).toBe(false);
      expect(result.authenticated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Watchdog env defaults (reliability)
  // ---------------------------------------------------------------------------

  describe('stream watchdog env', () => {
    it('seeds CLAUDE_ENABLE_STREAM_WATCHDOG=1 and CLAUDE_STREAM_IDLE_TIMEOUT_MS=90000 by default', async () => {
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      const env = lastQueryOptions().env as Record<string, string | undefined>;
      expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('1');
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('90000');
    });

    it('lets caller process.env override the watchdog defaults (direct/non-compat path)', async () => {
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '0';
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '12345';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      const env = lastQueryOptions().env as Record<string, string | undefined>;
      expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('0');
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('12345');
    });

    it('[Fix1] ClaudeCompatibleProvider path ignores hostile process.env watchdog override (clean-switch isolation)', async () => {
      // A hostile process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS must NOT leak into
      // the compat-provider subprocess env — it would shrink the timeout and
      // cause spurious watchdog trips that look like legitimate provider errors.
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '100';
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '0';
      mockQuery([{ type: 'text', text: 'test' }]);

      const compatProvider = {
        id: 'compat-1',
        name: 'Test Compat',
        providerType: 'anthropic' as const,
        baseUrl: 'https://api.example.com',
        apiKeySource: 'inline' as const,
        apiKey: 'test-key',
        models: [],
      };

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        claudeCompatibleProvider: compatProvider as never,
      });

      await collectAsyncGenerator(generator);

      const env = lastQueryOptions().env as Record<string, string | undefined>;
      // Must use fixed defaults, NOT the hostile process.env values
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('90000');
      expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('1');
    });

    it('[Fix1] Direct (no-provider) path allows process.env watchdog override', async () => {
      // On the direct-Anthropic path, the operator controls the environment and
      // their overrides must be respected.
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '100';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        // no claudeCompatibleProvider — direct path
      });

      await collectAsyncGenerator(generator);

      const env = lastQueryOptions().env as Record<string, string | undefined>;
      // Direct path: process.env override is honored
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('100');
    });
  });

  describe('environment variable passthrough', () => {
    afterEach(() => {
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    });

    it('should pass ANTHROPIC_BASE_URL to SDK env', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://custom.example.com/v1';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test',
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'https://custom.example.com/v1',
          }),
        }),
      });
    });

    it('should pass ANTHROPIC_AUTH_TOKEN to SDK env', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'custom-auth-token';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test',
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_AUTH_TOKEN: 'custom-auth-token',
          }),
        }),
      });
    });

    it('should pass both custom endpoint vars together', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
      });

      await collectAsyncGenerator(generator);

      expect(sdk.query).toHaveBeenCalledWith({
        prompt: 'Test',
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'https://gateway.example.com',
            ANTHROPIC_AUTH_TOKEN: 'gateway-token',
          }),
        }),
      });
    });

    it('should prefer credentials file API key over process.env (Amendment A1 precedence)', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockQuery([{ type: 'text', text: 'test' }]);

      const generator = provider.executeQuery({
        prompt: 'Test',
        model: 'claude-opus-4-8',
        cwd: '/test',
        credentials: { apiKeys: { anthropic: 'creds-key' } } as never,
      });

      await collectAsyncGenerator(generator);

      const env = lastQueryOptions().env as Record<string, string | undefined>;
      expect(env.ANTHROPIC_API_KEY).toBe('creds-key');
    });
  });

  // ---------------------------------------------------------------------------
  // Model catalog (driven by the capability table)
  // ---------------------------------------------------------------------------

  describe('getAvailableModels', () => {
    it('should return 5 Claude models', () => {
      const models = provider.getAvailableModels();
      expect(models).toHaveLength(5);
    });

    it('should include Claude Opus 4.8 as the default', () => {
      const models = provider.getAvailableModels();
      const opus = models.find((m) => m.id === 'claude-opus-4-8');
      expect(opus).toBeDefined();
      expect(opus?.name).toBe('Claude Opus 4.8');
      expect(opus?.provider).toBe('anthropic');
      expect(opus?.default).toBe(true);
      expect(opus?.contextWindow).toBe(1_000_000);
    });

    it('should include Claude Sonnet 4.6 with 1M context', () => {
      const models = provider.getAvailableModels();
      const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
      expect(sonnet).toBeDefined();
      expect(sonnet?.name).toBe('Claude Sonnet 4.6');
      expect(sonnet?.contextWindow).toBe(1_000_000);
    });

    it('should include Claude Haiku 4.5 with 200k context', () => {
      const models = provider.getAvailableModels();
      const haiku = models.find((m) => m.id === 'claude-haiku-4-5-20251001');
      expect(haiku).toBeDefined();
      expect(haiku?.contextWindow).toBe(200_000);
    });

    it('should include opus-4-6 and sonnet-4-20250514 marked deprecated in description', () => {
      const models = provider.getAvailableModels();

      const opus46 = models.find((m) => m.id === 'claude-opus-4-6');
      expect(opus46).toBeDefined();
      expect(opus46?.description).toMatch(/deprecated/i);

      const sonnet4 = models.find((m) => m.id === 'claude-sonnet-4-20250514');
      expect(sonnet4).toBeDefined();
      expect(sonnet4?.description).toMatch(/deprecated/i);
    });

    it('should no longer include claude-3-5-sonnet', () => {
      const models = provider.getAvailableModels();
      expect(models.find((m) => m.id === 'claude-3-5-sonnet-20241022')).toBeUndefined();
    });

    it('should mark exactly one model as default', () => {
      const models = provider.getAvailableModels();
      const defaults = models.filter((m) => m.default === true);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe('claude-opus-4-8');
    });

    it('should all support vision and tools', () => {
      const models = provider.getAvailableModels();
      models.forEach((model) => {
        expect(model.supportsVision).toBe(true);
        expect(model.supportsTools).toBe(true);
      });
    });

    it('should have modelString field matching id', () => {
      const models = provider.getAvailableModels();
      models.forEach((model) => {
        expect(model.modelString).toBe(model.id);
      });
    });
  });

  describe('supportsFeature', () => {
    it("should support 'tools' feature", () => {
      expect(provider.supportsFeature('tools')).toBe(true);
    });

    it("should support 'text' feature", () => {
      expect(provider.supportsFeature('text')).toBe(true);
    });

    it("should support 'vision' feature", () => {
      expect(provider.supportsFeature('vision')).toBe(true);
    });

    it("should support 'thinking' feature", () => {
      expect(provider.supportsFeature('thinking')).toBe(true);
    });

    it("should not support 'mcp' feature", () => {
      expect(provider.supportsFeature('mcp')).toBe(false);
    });

    it("should not support 'cli' feature", () => {
      expect(provider.supportsFeature('cli')).toBe(false);
    });

    it('should not support unknown features', () => {
      expect(provider.supportsFeature('unknown')).toBe(false);
    });
  });

  describe('validateConfig', () => {
    it('should validate config from base class', () => {
      const result = provider.validateConfig();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('config management', () => {
    it('should get and set config', () => {
      provider.setConfig({ apiKey: 'test-key' });
      const config = provider.getConfig();
      expect(config.apiKey).toBe('test-key');
    });

    it('should merge config updates', () => {
      provider.setConfig({ apiKey: 'key1' });
      provider.setConfig({ model: 'model1' });
      const config = provider.getConfig();
      expect(config.apiKey).toBe('key1');
      expect(config.model).toBe('model1');
    });
  });
});
