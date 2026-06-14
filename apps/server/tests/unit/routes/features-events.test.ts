import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/events/event-log.js', () => ({
  readEventLog: vi.fn(async () => [
    { v: 1, id: '0001', ts: 't', kind: 'agent_message', provider: 'claude', text: 'hi' },
  ]),
}));

import { createEventsHandler } from '../../../src/routes/features/routes/events.js';

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe('POST /api/features/events handler', () => {
  it('400 when projectPath/featureId missing', async () => {
    const res = mockRes();
    await createEventsHandler()({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('returns events from readEventLog', async () => {
    const res = mockRes();
    await createEventsHandler()(
      { body: { projectPath: '/p', featureId: 'f1' } } as never,
      res as never
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { success: boolean; events: unknown[] }).events).toHaveLength(1);
  });
});
