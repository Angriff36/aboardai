/**
 * Model discovery for Claude-compatible providers (z.AI GLM, MiniMax,
 * OpenRouter, custom endpoints) via `GET {baseUrl}/v1/models`.
 *
 * Anthropic-style and OpenAI-style endpoints both answer with `{ data: [...] }`.
 */

import type { ClaudeModelAlias, ProviderModel } from '@aboardai/types';

export interface DiscoveredCompatibleModel {
  id: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
}

export interface CompatibleDiscoveryOptions {
  baseUrl: string;
  apiKey: string;
}

/**
 * Parse a `/v1/models` payload. Returns null when the payload carries no model
 * list so callers can surface the provider's own error message.
 */
export function parseCompatibleModelsResponse(
  payload: unknown
): DiscoveredCompatibleModel[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) return null;

  const seen = new Set<string>();
  const models: DiscoveredCompatibleModel[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push({ id, displayName: id });
      }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const id =
      typeof item.id === 'string'
        ? item.id.trim()
        : typeof item.name === 'string'
          ? item.name.trim()
          : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName =
      typeof item.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : id;
    const description = typeof item.description === 'string' ? item.description.trim() : undefined;
    const contextWindow =
      typeof item.context_length === 'number'
        ? item.context_length
        : typeof item.context_window === 'number'
          ? item.context_window
          : undefined;

    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return models;
}

/** Pull a human-readable error out of a provider error payload. */
export function extractProviderErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.msg === 'string') return record.msg;
  if (typeof record.message === 'string') return record.message;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/**
 * Build the models URL. Base URLs are stored without a version (`…/anthropic`,
 * `…/api`), but some users enter `…/v1`; do not double the version segment.
 */
export function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** Fetch models from a Claude-compatible endpoint. Throws with the provider's message on failure. */
export async function fetchClaudeCompatibleModels(
  options: CompatibleDiscoveryOptions
): Promise<DiscoveredCompatibleModel[]> {
  const url = buildModelsUrl(options.baseUrl);
  const authHeaders: Record<string, string> = {
    'x-api-key': options.apiKey,
    Authorization: `Bearer ${options.apiKey}`,
  };

  const request = async (headers: Record<string, string>) => {
    // Never follow redirects: Node keeps custom headers (x-api-key) on a
    // cross-origin redirect, which would hand the key to another host.
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Model list endpoint redirected (HTTP ${response.status}). Use the final URL as the base URL.`
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Model list request failed: HTTP ${response.status} (response was not JSON)`);
    }
    return { status: response.status, payload, models: parseCompatibleModelsResponse(payload) };
  };

  // Plain request first: OpenRouter answers `anthropic-version` + key with a
  // trimmed Anthropic-compat listing instead of its full catalog. Endpoints
  // that require the version header get a second try with it.
  let result = await request(authHeaders);
  if (!result.models) {
    result = await request({ ...authHeaders, 'anthropic-version': '2023-06-01' });
  }

  if (!result.models) {
    const raw = extractProviderErrorMessage(result.payload);
    const detail = raw ? sanitizeProviderMessage(raw, options.apiKey) : `HTTP ${result.status}`;
    throw new Error(`Provider did not return a model list: ${detail}`);
  }
  return result.models;
}

/** Looks like a credential: sk-…, Bearer tokens, or any long opaque token. */
const SECRET_LIKE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Za-z0-9_-]{24,})\b/g;

/**
 * Provider error text is untrusted and ends up in logs and HTTP responses:
 * drop the caller's key if echoed, mask anything key-shaped, and cap length.
 */
export function sanitizeProviderMessage(message: string, apiKey?: string): string {
  let text = message.replace(/[\r\n]+/g, ' ').trim();
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  text = text.replace(SECRET_LIKE_PATTERN, '[redacted]');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const HAIKU_PATTERN = /(^|[-_/ .:])(haiku|flash|air|mini|lite|small|nano|fast)(?=$|[-_/ .:0-9])/i;
const OPUS_PATTERN = /(^|[-_/ .:])(opus|pro|max|large|ultra)(?=$|[-_/ .:0-9])/i;

/** Guess which Claude tier a discovered model best stands in for. */
export function inferClaudeAlias(modelId: string): ClaudeModelAlias {
  if (HAIKU_PATTERN.test(modelId)) return 'haiku';
  if (OPUS_PATTERN.test(modelId)) return 'opus';
  return 'sonnet';
}

/** Convert discovered models to the settings `ProviderModel` shape. */
export function toProviderModels(models: DiscoveredCompatibleModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    mapsToClaudeModel: inferClaudeAlias(model.id),
  }));
}
