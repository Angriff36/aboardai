/**
 * Unit tests for GET /api/groups/list handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../../utils/mocks.js';
import { createListHandler } from '../../../../src/routes/groups/routes/list.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@aboardai/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Unknown error'),
  createLogError: () => () => {},
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/groups/list', () => {
  let req: Request;
  let res: Response;

  const mockSnapshot = {
    id: 'group-1',
    name: 'Group 1',
    status: 'pending',
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

  function buildGroupService(groups = [mockSnapshot]) {
    const mockStore = {
      loadAllGroups: vi.fn().mockResolvedValue(groups),
    };
    return {
      mockGroupService: {
        getProjectGroup: vi.fn().mockResolvedValue({ store: mockStore }),
      } as unknown as any,
      mockStore,
    };
  }

  it('happy path: returns array of groups', async () => {
    const { mockGroupService } = buildGroupService([mockSnapshot]);
    req.query = { projectPath: '/test/proj' };

    const handler = createListHandler(mockGroupService);
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      groups: [mockSnapshot],
    });
  });

  it('returns empty array when no groups exist', async () => {
    const { mockGroupService } = buildGroupService([]);
    req.query = { projectPath: '/test/proj' };

    const handler = createListHandler(mockGroupService);
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, groups: [] });
  });

  it('400: missing projectPath', async () => {
    const { mockGroupService } = buildGroupService();
    req.query = {};

    const handler = createListHandler(mockGroupService);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('projectPath') })
    );
  });
});
