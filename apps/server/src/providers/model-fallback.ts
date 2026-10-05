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

const ACCOUNT_WIDE_TYPES = new Set([
  ErrorType.AUTHENTICATION,
  ErrorType.BILLING,
  ErrorType.CLI_NOT_FOUND,
]);
const ACCOUNT_WIDE_TEXT =
  /disconnected from the app|not logged in|not authenticated|api_error_status=401/i;

/**
 * Remember a failure that affects the whole account (out of usage, auth,
 * billing, missing CLI) so later jobs skip it. Model-specific or short
 * failures (unsupported model, rate limit) only move the current job.
 */
export function noteAccountFailure(key: string, error: unknown): void {
  const text = errorText(error);
  const accountWide =
    isOutOfUsage(error) ||
    ACCOUNT_WIDE_TEXT.test(text) ||
    ACCOUNT_WIDE_TYPES.has(classifyError(new Error(text)).type);
  if (!accountWide) {
    logger.warn(`Moving this job off ${key}: ${text.slice(0, 300)}`);
    return;
  }
  unavailableUntil.set(key, Date.now() + PROVIDER_COOLDOWN_MS);
  logger.warn(`Skipping ${key} for 30 minutes: ${text.slice(0, 300)}`);
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

const CONTINUATION_NOTE =
  'NOTE: Another AI model started this task and stopped partway (its account ran out of usage or became unavailable). ' +
  'The working directory may already contain its partial changes. Inspect the current state first ' +
  '(for example git status and git diff), keep the work that is correct, and continue the task from there. ' +
  'Do not redo or duplicate work that is already done.\n\n';

/** What the failed model already did, so the backup continues instead of restarting. */
export interface FallbackContinuation {
  /** The failed model used tools or produced job output: files may have changed. */
  workStarted?: boolean;
  /** Text the failed model already streamed to the caller. */
  partialResponse?: string;
}

function withContinuationNote(
  prompt: ExecuteOptions['prompt'],
  continuation: FallbackContinuation
): ExecuteOptions['prompt'] {
  let note = continuation.workStarted ? CONTINUATION_NOTE : '';
  if (continuation.partialResponse) {
    note +=
      'NOTE: Another AI model already sent the start of the answer below and then stopped. ' +
      'Continue the answer exactly where it stops. Output only the remaining part; do not repeat any of it.\n' +
      `<<<PARTIAL ANSWER\n${continuation.partialResponse}\nPARTIAL ANSWER>>>\n\n`;
  }
  if (!note) return prompt;
  if (typeof prompt === 'string') return note + prompt;
  return [{ type: 'text', text: note }, ...prompt];
}

/**
 * Next model on an account that has not failed in this job and is not
 * cooling down. Returns undefined when every account is out. When the failed
 * model already did work or streamed text, the new model is told to continue
 * in place instead of starting over.
 */
export async function nextFallback(
  options: ExecuteOptions,
  triedAccounts: ReadonlySet<string>,
  continuation: FallbackContinuation = {}
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
        prompt: withContinuationNote(options.prompt, continuation),
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
