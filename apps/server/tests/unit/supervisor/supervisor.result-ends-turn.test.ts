import { describe, expect, it } from 'vitest';
import type { ProviderMessage } from '@aboardai/types';
import { superviseQuery } from '../../../src/providers/provider-supervisor.js';
import type { BaseProvider } from '../../../src/providers/base-provider.js';

describe('superviseQuery result handling', () => {
  it('ends the job at a successful result even when the provider never closes', async () => {
    let closed = false;
    const provider = {
      getName: () => 'codex',
      executeQuery: async function* () {
        try {
          yield { type: 'result', subtype: 'success', result: 'done' } as ProviderMessage;
          // The CLI stays alive after its final event.
          await new Promise(() => {});
        } finally {
          closed = true;
        }
      },
    } as unknown as BaseProvider;

    const messages: ProviderMessage[] = [];
    for await (const msg of superviseQuery(provider, {
      prompt: 'Build it',
      model: 'm',
      cwd: '/tmp',
    })) {
      messages.push(msg);
    }

    expect(messages.filter((msg) => msg.type === 'result')).toHaveLength(1);
    expect(closed).toBe(true);
  });
});
