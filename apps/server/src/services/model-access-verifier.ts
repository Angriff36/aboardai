import type { ModelAccessVerificationResult, ModelAssignmentCandidate } from '@aboardai/types';
import { resolveModelString } from '@aboardai/model-resolver';
import { resolveProviderContext } from '../lib/settings-helpers.js';
import type { SettingsService } from './settings-service.js';
import {
  simpleQuery,
  type SimpleQueryOptions,
  type SimpleQueryResult,
} from '../providers/simple-query-service.js';

export type ModelProbe = (options: SimpleQueryOptions) => Promise<SimpleQueryResult>;
type ProviderResolver = typeof resolveProviderContext;

export interface ModelAccessVerifierDependencies {
  probe?: ModelProbe;
  resolveProvider?: ProviderResolver;
  concurrency?: number;
  timeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/401|403|auth|token|credential|login/.test(message)) return 'Authentication failed';
  if (/billing|subscription|payment|quota/.test(message)) {
    return 'Subscription or billing access unavailable';
  }
  if (/429|rate.?limit/.test(message)) return 'Rate limit reached';
  if (/abort|timed?\s*out|timeout/.test(message)) return 'Verification timed out';
  return 'Provider request failed';
}

export async function verifyModelAccess(
  candidates: readonly ModelAssignmentCandidate[],
  projectPath: string,
  settingsService: SettingsService,
  dependencies: ModelAccessVerifierDependencies = {}
): Promise<ModelAccessVerificationResult[]> {
  if (process.env.ABOARDAI_MOCK_AGENT === 'true') {
    return candidates.map(({ key }) => ({ key, status: 'verified' }));
  }

  const probe = dependencies.probe ?? simpleQuery;
  const resolveProvider = dependencies.resolveProvider ?? resolveProviderContext;
  const concurrency = Math.max(1, Math.min(dependencies.concurrency ?? DEFAULT_CONCURRENCY, 5));
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = new Array<ModelAccessVerificationResult>(candidates.length);
  let nextIndex = 0;

  const verifyOne = async (candidate: ModelAssignmentCandidate) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      let model = candidate.providerId ? candidate.model : resolveModelString(candidate.model);
      let providerContext: Awaited<ReturnType<typeof resolveProviderContext>> | undefined;
      if (candidate.providerId) {
        providerContext = await resolveProvider(
          settingsService,
          candidate.model,
          candidate.providerId,
          '[ModelAccessVerifier]'
        );
        if (!providerContext.provider) {
          throw new Error('Configured provider is unavailable');
        }
        model = providerContext.resolvedModel ?? candidate.model;
      }

      const operation = probe({
        prompt: 'Reply with only: ok',
        model,
        cwd: projectPath,
        maxTurns: 1,
        allowedTools: [],
        readOnly: true,
        settingSources: [],
        abortController,
        thinkingLevel: candidate.thinkingLevel,
        reasoningEffort: candidate.reasoningEffort,
        claudeCompatibleProvider: providerContext?.provider,
        credentials: providerContext?.credentials,
      });
      const timeout = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(new Error('Verification timed out')),
          { once: true }
        );
      });
      await Promise.race([operation, timeout]);
      return { key: candidate.key, status: 'verified' as const };
    } catch (error) {
      return {
        key: candidate.key,
        status: 'unavailable' as const,
        error: safeProviderError(error),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      results[index] = await verifyOne(candidates[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
  );
  return results;
}
