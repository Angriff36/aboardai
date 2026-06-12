/**
 * Unit tests for GET /api/groups/get handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../../utils/mocks.js';
import { createGetHandler } from '../../../../src/routes/groups/routes/get.js';

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

describe('GET /api/groups/get', () => {
  let req: Request;
  let res: Response;

  const mockSnapshot = {
    id: 'group-abc',
    name: 'Test Group',
    status: 'pending',
    children: [{ featureId: 'feat-1', status: 'pending', attempts: 0 }],
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
      engineThrows?: boolean;
      storedGroups?: (typeof mockSnapshot)[];
    } = {}
  ) {
    const mockEngine = {
      getSnapshot: opts.engineThrows
        ? vi.fn().mockRejectedValue(new Error('GroupEngine: no children for group'))
        : vi.fn().mockResolvedValue(mockSnapshot),
      rehydrateGroup: vi.fn().mockResolvedValue(undefined),
    };

    const storedGroups = opts.storedGroups ?? [mockSnapshot];
    const mockStore = {
      loadAllGroups: vi.fn().mockResolvedValue(storedGroups),
    };

    return {
      mockGroupService: {
        getProjectGroup: vi.fn().mockResolvedValue({ engine: mockEngine, store: mockStore }),
      } as unknown as any,
      mockEngine,
      mockStore,
    };
  }

  it('happy path: returns snapshot from engine', async () => {
    const { mockGroupService } = buildGroupService();
    req.query = { projectPath: '/test/proj', groupId: 'group-abc' };

    const handler = createGetHandler(mockGroupService);
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, group: mockSnapshot });
  });

  it('400: missing projectPath', async () => {
    const { mockGroupService } = buildGroupService();
    req.query = { groupId: 'group-abc' };

    const handler = createGetHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400: missing groupId', async () => {
    const { mockGroupService } = buildGroupService();
    req.query = { projectPath: '/test/proj' };

    const handler = createGetHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rehydrates from store when engine does not have group loaded', async () => {
    const { mockGroupService, mockEngine } = buildGroupService({
      engineThrows: true,
      storedGroups: [mockSnapshot],
    });
    // After rehydration, getSnapshot should succeed
    mockEngine.getSnapshot
      .mockRejectedValueOnce(new Error('GroupEngine: no children for group'))
      .mockResolvedValueOnce(mockSnapshot);

    req.query = { projectPath: '/test/proj', groupId: 'group-abc' };

    const handler = createGetHandler(mockGroupService);
    await handler(req, res);

    expect(mockEngine.rehydrateGroup).toHaveBeenCalledWith(mockSnapshot);
    expect(res.json).toHaveBeenCalledWith({ success: true, group: mockSnapshot });
  });

  it('404: group not found in engine or store', async () => {
    const { mockGroupService } = buildGroupService({
      engineThrows: true,
      storedGroups: [], // nothing in store either
    });

    req.query = { projectPath: '/test/proj', groupId: 'nonexistent-group' };

    const handler = createGetHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('not found') })
    );
  });
});
