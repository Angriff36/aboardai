import { describe, it, expect } from 'vitest';
import { parseAnthropicModelsResponse } from '../../../src/providers/claude-model-discovery.js';
import { parseGeminiModelsResponse } from '../../../src/providers/gemini-model-discovery.js';
import {
  extractProviderErrorMessage,
  inferClaudeAlias,
  parseCompatibleModelsResponse,
  toProviderModels,
} from '../../../src/providers/claude-compatible-model-discovery.js';
import {
  isTrustedBaseUrl,
  resolveServerHeldKey,
} from '../../../src/routes/setup/routes/claude-compatible-models.js';

describe('claude-model-discovery', () => {
  it('parses the Anthropic /v1/models payload and dedupes ids', () => {
    const payload = {
      data: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', type: 'model' },
        { id: 'claude-opus-4-8', display_name: 'dupe' },
        { id: 'claude-sonnet-4-6', display_name: '' },
        { id: '', display_name: 'nope' },
        'garbage',
      ],
      has_more: false,
    };

    expect(parseAnthropicModelsResponse(payload)).toEqual([
      { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', displayName: 'claude-sonnet-4-6' },
    ]);
  });

  it('returns an empty list for payloads without data', () => {
    expect(
      parseAnthropicModelsResponse({ error: { message: 'x-api-key header is required' } })
    ).toEqual([]);
    expect(parseAnthropicModelsResponse(null)).toEqual([]);
  });
});

describe('gemini-model-discovery', () => {
  it('keeps chat-capable gemini models and drops tts/image/embedding variants', () => {
    const payload = {
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          description: 'Fast',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          thinking: true,
        },
        {
          name: 'models/gemini-2.5-flash-preview-tts',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-embedding-001',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-3-pro-preview',
          displayName: 'Gemini 3 Pro Preview',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/imagen-4.0-generate-001',
          supportedGenerationMethods: ['predict'],
        },
      ],
    };

    const models = parseGeminiModelsResponse(payload);
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-3-pro-preview']);
    expect(models[0]).toMatchObject({
      name: 'Gemini 2.5 Flash',
      provider: 'gemini',
      modelString: 'gemini-2.5-flash',
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      hasReasoning: true,
      supportsTools: true,
    });
    expect(models[1].hasReasoning).toBe(true);
  });

  it('returns an empty list for payloads without models', () => {
    expect(parseGeminiModelsResponse({ error: { code: 403 } })).toEqual([]);
  });
});

describe('claude-compatible-model-discovery', () => {
  it('parses Anthropic-style and OpenAI-style data arrays', () => {
    expect(
      parseCompatibleModelsResponse({
        data: [
          { id: 'GLM-5', display_name: 'GLM 5' },
          { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', context_length: 204800 },
          { object: 'model', id: 'glm-4.5-air' },
          'glm-4.7',
        ],
      })
    ).toEqual([
      { id: 'GLM-5', displayName: 'GLM 5' },
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5', contextWindow: 204800 },
      { id: 'glm-4.5-air', displayName: 'glm-4.5-air' },
      { id: 'glm-4.7', displayName: 'glm-4.7' },
    ]);
  });

  it('returns null when the provider answered with an error instead of a list', () => {
    const zaiUnauthenticated = {
      code: 1001,
      msg: 'Authentication parameter not received in Header, unable to authenticate',
      success: false,
    };
    expect(parseCompatibleModelsResponse(zaiUnauthenticated)).toBeNull();
    expect(extractProviderErrorMessage(zaiUnauthenticated)).toBe(
      'Authentication parameter not received in Header, unable to authenticate'
    );

    const anthropicStyle = {
      type: 'error',
      error: { type: 'authentication_error', message: 'login fail' },
    };
    expect(parseCompatibleModelsResponse(anthropicStyle)).toBeNull();
    expect(extractProviderErrorMessage(anthropicStyle)).toBe('login fail');
  });

  it('infers a Claude tier from the model id', () => {
    expect(inferClaudeAlias('glm-4.5-air')).toBe('haiku');
    expect(inferClaudeAlias('MiniMax-M2.5')).toBe('sonnet');
    expect(inferClaudeAlias('anthropic/claude-opus-4.8')).toBe('opus');
    expect(inferClaudeAlias('google/gemini-2.5-flash')).toBe('haiku');
    expect(inferClaudeAlias('GLM-5')).toBe('sonnet');
  });

  it('only trusts saved-provider and template base URLs for server-held keys', () => {
    const saved = [{ baseUrl: 'https://my-proxy.example.com/anthropic/' }];
    expect(isTrustedBaseUrl('https://my-proxy.example.com/anthropic', saved)).toBe(true);
    expect(isTrustedBaseUrl('https://api.z.ai/api/anthropic', [])).toBe(true);
    expect(isTrustedBaseUrl('https://openrouter.ai/api', [])).toBe(true);
    expect(isTrustedBaseUrl('https://attacker.example.com/v1', saved)).toBe(false);
    expect(isTrustedBaseUrl('http://169.254.169.254', saved)).toBe(false);
    expect(isTrustedBaseUrl('', saved)).toBe(false);
  });

  it('resolves server-held keys only from the provider that owns the URL', () => {
    const credentials = {
      version: 1,
      apiKeys: { anthropic: 'anthropic-secret', google: '', openai: '', zai: 'zai-secret' },
    };
    const saved = [
      { baseUrl: 'https://proxy.example.com/anthropic', apiKeySource: 'credentials' },
      { baseUrl: 'https://api.minimax.io/anthropic', apiKeySource: 'inline', apiKey: 'mm-key' },
      { baseUrl: 'https://envprov.example.com', apiKeySource: 'env' },
    ];
    const env = { ANTHROPIC_API_KEY: 'env-secret' } as NodeJS.ProcessEnv;

    // Each saved provider yields only its own configured key
    expect(
      resolveServerHeldKey('https://proxy.example.com/anthropic/', saved, credentials, env)
    ).toBe('anthropic-secret');
    expect(resolveServerHeldKey('https://api.minimax.io/anthropic', saved, credentials, env)).toBe(
      'mm-key'
    );
    expect(resolveServerHeldKey('https://envprov.example.com', saved, credentials, env)).toBe(
      'env-secret'
    );

    // Template URLs without a saved provider: only the GLM template may use the z.ai key
    expect(resolveServerHeldKey('https://api.z.ai/api/anthropic', [], credentials, env)).toBe(
      'zai-secret'
    );
    expect(resolveServerHeldKey('https://openrouter.ai/api', [], credentials, env)).toBeUndefined();

    // Unknown URLs never receive a server-held key
    expect(
      resolveServerHeldKey('https://attacker.example.com/v1', saved, credentials, env)
    ).toBeUndefined();
  });

  it('converts discovered models to ProviderModel entries', () => {
    expect(toProviderModels([{ id: 'GLM-5', displayName: 'GLM 5' }])).toEqual([
      { id: 'GLM-5', displayName: 'GLM 5', mapsToClaudeModel: 'sonnet' },
    ]);
  });
});
