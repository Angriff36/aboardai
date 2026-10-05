/**
 * Model fallback — keep work running when a model's account is out of usage.
 *
 * When a provider fails with a usage limit, quota, billing, auth, missing CLI,
 * or unsupported-model error, the job moves to the next model that has a
 * different account. A failed provider is skipped for a while so later jobs
 * do not waste time on it.
 */

import type { BaseProvider } from './base-provider.js';
import type { ExecuteOptions } from '@aboardai/types';
import { DEFAULT_MODELS, stripProviderPrefix } from '@aboardai/types';
import { resolveModelString } from '@aboardai/model-resolver';
import { createLogger } from '@aboardai/utils';
import { classifyError, ErrorType } from '../lib/error-handler.js';

const logger = createLogger('ModelFallback');

/** How long a provider that ran out of usage is skipped. */
const PROVIDER_COOLDOWN_MS = 30 * 60 * 1000;

const SWITCH_TYPES = new Set([
  ErrorType.AUTHENTICATION,
  ErrorType.BILLING,
  ErrorType.RATE_LIMIT,
  ErrorType.CLI_NOT_FOUND,
  ErrorType.MODEL_NOT_SUPPORTED,
]);

const USAGE_TEXT =
  /usage limit|hit your (usage )?limit|spend limit|out of (credits|usage)|credit balance|quota|billing|does not support this model|disconnected from the app|not logged in|not authenticated|api_error_status=(401|403|429)/i;

const unavailableUntil = new Map<string, number>();
let codexModelSource: (() => Promise<string[]>) | undefined;

/** Startup hook: live Codex model ids (prefixed, default first). */
export function setCodexFallbackModelSource(source: () => Promise<string[]>): void {
  codexModelSource = source;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current =
        (current as Error & { cause?: unknown; lastError?: unknown }).cause ??
        (current as { lastError?: unknown }).lastError;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

const OUT_OF_USAGE_TEXT =
  /usage limit|hit your (usage )?limit|spend limit|out of (credits|usage)|credit balance|quota/i;

/** True when the account is out of usage: waiting and retrying the same model will not help. */
export function isOutOfUsage(error: unknown): boolean {
  return OUT_OF_USAGE_TEXT.test(errorText(error));
}

/** True when the failure means "this account cannot run this model now". */
export function isModelAccessError(error: unknown): boolean {
  const text = errorText(error);
  if (USAGE_TEXT.test(text)) return true;
  return SWITCH_TYPES.has(classifyError(new Error(text)).type);
}

/** Account identity: a custom Claude-compatible endpoint is its own account. */
export function accountKey(provider: BaseProvider, options: ExecuteOptions): string {
  return options.claudeCompatibleProvider?.id
    ? `claude-compatible:${options.claudeCompatibleProvider.id}`
    : typeof provider.getName === 'function'
      ? provider.getName()
      : 'unknown';
}

export function markAccountUnavailable(key: string, reason: string): void {
  unavailableUntil.set(key, Date.now() + PROVIDER_COOLDOWN_MS);
  logger.warn(`Skipping ${key} for 30 minutes: ${reason.slice(0, 300)}`);
}

export function clearAccountUnavailable(key: string): void {
  unavailableUntil.delete(key);
}

export function isAccountUnavailable(key: string): boolean {
  const until = unavailableUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  unavailableUntil.delete(key);
  return false;
}

/** Test hook. */
export function resetModelFallbackState(): void {
  unavailableUntil.clear();
  codexModelSource = undefined;
}

async function fallbackModelIds(): Promise<string[]> {
  let codex: string[] = [];
  try {
    codex = (await codexModelSource?.()) ?? [];
  } catch {
    // Live list unavailable — use the static default below.
  }
  if (codex.length === 0) codex = [DEFAULT_MODELS.codex];
  return ['claude-opus', codex[0], 'claude-sonnet', ...codex.slice(1, 3), DEFAULT_MODELS.cursor];
}

export interface FallbackTarget {
  provider: BaseProvider;
  options: ExecuteOptions;
  model: string;
  account: string;
}

/**
 * Next model on an account that has not failed in this job and is not
 * cooling down. Returns undefined when every account is out.
 */
export async function nextFallback(
  options: ExecuteOptions,
  triedAccounts: ReadonlySet<string>
): Promise<FallbackTarget | undefined> {
  // Loaded on demand: the factory pulls in every provider, which the supervisor must not.
  const { ProviderFactory } = await import('./provider-factory.js');
  for (const candidate of await fallbackModelIds()) {
    const resolved = resolveModelString(candidate);
    let provider: BaseProvider;
    try {
      provider = ProviderFactory.getProviderForModel(resolved);
    } catch {
      continue; // Provider disconnected in settings
    }
    const account = provider.getName();
    if (triedAccounts.has(account) || isAccountUnavailable(account)) continue;
    return {
      provider,
      model: resolved,
      account,
      options: {
        ...options,
        model: stripProviderPrefix(resolved),
        originalModel: resolved,
        sdkSessionId: undefined,
        claudeCompatibleProvider: undefined,
        thinkingLevel: undefined,
        reasoningEffort: undefined,
      },
    };
  }
  return undefined;
}
