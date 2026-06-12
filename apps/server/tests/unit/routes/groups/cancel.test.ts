/**
 * Unit tests for POST /api/groups/cancel handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../../utils/mocks.js';
import { createCancelHandler } from '../../../../src/routes/groups/routes/cancel.js';
import { GroupCommandDenied } from '../../../../src/groups/group-engine.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@aboardai/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Unknown error'),
  createLogError: () => vi.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/groups/cancel', () => {
  let req: Request;
  let res: Response;

  const mockSnapshot = {
    id: 'group-abc',
    name: 'Test Group',
    status: 'cancelled',
    children: [],
    baseBranch: null,
    maxConcurrency: 1,
    retryLimit: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const ctx = createMockExpressContext();
    req = ctx.req;
    res = ctx.res;
  });

  function buildGroupService(
    opts: {
      queueCancelThrows?: unknown;
      engineGetThrows?: boolean;
      storedGroups?: (typeof mockSnapshot)[];
    } = {}
  ) {
    const mockEngine = {
      getSnapshot: opts.engineGetThrows
        ? vi.fn().mockRejectedValue(new Error('no children'))
        : vi.fn().mockResolvedValue(mockSnapshot),
      rehydrateGroup: vi.fn().mockResolvedValue(undefined),
    };

    const storedGroups = opts.storedGroups ?? [mockSnapshot];
    const mockStore = {
      loadAllGroups: vi.fn().mockResolvedValue(storedGroups),
    };

    const mockQueue = {
      cancelGroup: opts.queueCancelThrows
        ? vi.fn().mockRejectedValue(opts.queueCancelThrows)
        : vi.fn().mockResolvedValue(undefined),
    };

    return {
      mockGroupService: {
        ensureProject: vi
          .fn()
          .mockResolvedValue({ engine: mockEngine, store: mockStore, queue: mockQueue }),
      } as unknown as any,
      mockQueue,
      mockEngine,
    };
  }

  it('happy path: queue.cancelGroup called, returns snapshot', async () => {
    const { mockGroupService, mockQueue } = buildGroupService();
    req.body = { projectPath: '/test/proj', groupId: 'group-abc' };

    const handler = createCancelHandler(mockGroupService);
    await handler(req, res);

    expect(mockQueue.cancelGroup).toHaveBeenCalledWith('/test/proj', 'group-abc');
    expect(res.json).toHaveBeenCalledWith({ success: true, group: mockSnapshot });
  });

  it('400: missing projectPath', async () => {
    const { mockGroupService } = buildGroupService();
    req.body = { groupId: 'group-abc' };

    const handler = createCancelHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400: missing groupId', async () => {
    const { mockGroupService } = buildGroupService();
    req.body = { projectPath: '/test/proj' };

    const handler = createCancelHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('409: GroupCommandDenied when cancelling a settled group', async () => {
    const denial = new GroupCommandDenied(
      'cancelGroup denied: status is not running or pending',
      {}
    );
    const { mockGroupService } = buildGroupService({ queueCancelThrows: denial });
    req.body = { projectPath: '/test/proj', groupId: 'group-abc' };

    const handler = createCancelHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: denial.message, guard: denial.formatted })
    );
  });

  it('404: group not found in engine or store', async () => {
    const { mockGroupService } = buildGroupService({
      engineGetThrows: true,
      storedGroups: [], // nothing in store
    });
    req.body = { projectPath: '/test/proj', groupId: 'nonexistent' };

    const handler = createCancelHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('not found') })
    );
  });
});
