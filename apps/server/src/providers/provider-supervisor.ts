/**
 * ProviderSupervisor — placeholder module (Task 2: fault-injection harness)
 *
 * The real implementation is Task 3. This placeholder exists so that
 * supervisor.scenarios.test.ts can import the module without a crash.
 * Every export throws 'not implemented' at runtime.
 */

import type { BaseProvider } from './base-provider.js';
import type { ExecuteOptions, ProviderMessage, SupervisorPolicy } from '@aboardai/types';

export type SupervisorStatusCallback = (
  status: import('@aboardai/types').SupervisorStatusMessage
) => void;

/**
 * Placeholder — throws 'not implemented' at runtime.
 * Tests import this; the supervisor suite must be RED because the
 * implementation is absent, not because the import explodes.
 */
export async function* superviseQuery(
  _provider: BaseProvider,
  _options: ExecuteOptions,
  _policy?: SupervisorPolicy,
  _onStatus?: SupervisorStatusCallback
): AsyncGenerator<ProviderMessage> {
  throw new Error('not implemented');
  // eslint-disable-next-line no-unreachable
  yield {} as ProviderMessage; // unreachable — makes TS treat this as AsyncGenerator
}
