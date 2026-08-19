/**
 * StreamActivity — stall-timer liveness rules for ProviderSupervisor
 *
 * Providers often yield tool_use / tool_result (and thinking) with no
 * assistant text while a long tool (build/test) runs. Those messages must
 * reset the stall timer the same way text does. Only a true silence —
 * no iterator.next() completion within stallTimeoutMs — is a stall.
 */

import type { ProviderMessage } from '@aboardai/types';

/**
 * True when a message from the provider iterator counts as stream activity.
 * Covers assistant (text | thinking | tool_use), user (tool_result), error,
 * and result. Forward-compatible for unknown provider types except
 * supervisor_status (never emitted by the inner provider stream).
 */
export class StreamActivity {
  static isLivenessSignal(msg: ProviderMessage): boolean {
    if (msg == null || typeof msg !== 'object') {
      return false;
    }

    switch (msg.type) {
      case 'assistant':
      case 'user':
      case 'error':
      case 'result':
        return true;
      case 'supervisor_status':
        return false;
      default:
        return true;
    }
  }
}
