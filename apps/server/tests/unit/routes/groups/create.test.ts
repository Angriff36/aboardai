/**
 * Unit tests for POST /api/groups/create handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../../utils/mocks.js';
import { createCreateHandler } from '../../../../src/routes/groups/routes/create.js';
import { GroupCommandDenied } from '../../../../src/groups/group-engine.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@aboardai/utils', () => ({
  atomicWriteJson: vi.fn(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Unknown error'),
  createLogError: () => vi.fn(),
}));

vi.mock('@aboardai/platform', () => ({
  getFeatureDir: vi.fn(),
}));

// ── Test setup ─────────────────────────────────────────────────────────────────

function buildFeature(id: string, status = 'backlog', branchName?: string) {
  return {
    id,
    status,
    branchName: branchName ?? null,
    dependencies: [],
    title: `Feature ${id}`,
  };
}

function buildMocks(
  overrides: {
    featureMap?: Record<string, ReturnType<typeof buildFeature> | null>;
    engineCreateThrows?: unknown;
  } = {}
) {
  const feat1 = buildFeature('feat-1');
  const feat2 = buildFeature('feat-2');
  const featureMap: Record<string, ReturnType<typeof buildFeature> | null> =
    overrides.featureMap ?? {
      'feat-1': feat1,
      'feat-2': feat2,
    };

  const mockSnapshot = {
    id: 'generated-uuid',
    name: 'Test Group',
    baseBranch: null,
    maxConcurrency: 1,
    retryLimit: 0,
    status: 'pending',
    children: [
      { featureId: 'feat-1', status: 'pending', attempts: 0 },
      { featureId: 'feat-2', status: 'pending', attempts: 0 },
    ],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockEngine = {
    createGroup: overrides.engineCreateThrows
      ? vi.fn().mockRejectedValue(overrides.engineCreateThrows)
      : vi.fn().mockResolvedValue([]),
    getSnapshot: vi.fn().mockResolvedValue(mockSnapshot),
    rehydrateGroup: vi.fn().mockResolvedValue(undefined),
  };

  const mockStore = {
    saveGroup: vi.fn().mockResolvedValue(undefined),
    loadAllGroups: vi.fn().mockResolvedValue([]),
  };

  const mockGroupService = {
    ensureProject: vi.fn().mockResolvedValue({ engine: mockEngine, store: mockStore, queue: {} }),
    getProjectGroup: vi.fn().mockResolvedValue({ engine: mockEngine, store: mockStore, queue: {} }),
    resumeProject: vi.fn().mockResolvedValue(undefined),
  } as unknown as any;

  const mockFeatureLoader = {
    get: vi
      .fn()
      .mockImplementation((_: string, featureId: string) =>
        Promise.resolve(featureMap[featureId] ?? null)
      ),
  } as unknown as any;

  return { mockGroupService, mockFeatureLoader, mockEngine, mockStore };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/groups/create', () => {
  let req: Request;
  let res: Response;

  beforeEach(async () => {
    vi.clearAllMocks();
    const ctx = createMockExpressContext();
    req = ctx.req;
    res = ctx.res;

    // Reset platform mock — getFeatureDir returns path based on featureId
    const { getFeatureDir } = await import('@aboardai/platform');
    vi.mocked(getFeatureDir).mockImplementation(
      (projectPath: string, featureId: string) => `${projectPath}/.aboardai/features/${featureId}`
    );

    // Reset utils mock
    const { atomicWriteJson } = await import('@aboardai/utils');
    vi.mocked(atomicWriteJson).mockResolvedValue(undefined);
  });

  it('happy path: valid 2-feature group created, returns snapshot', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks();
    req.body = {
      projectPath: '/test/proj',
      name: 'Test Group',
      featureIds: ['feat-1', 'feat-2'],
    };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        group: expect.objectContaining({ name: 'Test Group' }),
      })
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('400: missing projectPath', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks();
    req.body = { name: 'Test Group', featureIds: ['feat-1', 'feat-2'] };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('projectPath') })
    );
  });

  it('400: missing featureIds', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks();
    req.body = { projectPath: '/test/proj', name: 'Test Group' };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('featureIds') })
    );
  });

  it('400: featureIds count < 2', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks();
    req.body = { projectPath: '/test/proj', name: 'Test Group', featureIds: ['feat-1'] };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400: feature not found (featureLoader returns null)', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks({
      featureMap: { 'feat-1': buildFeature('feat-1'), 'feat-2': null },
    });
    req.body = { projectPath: '/test/proj', name: 'Test Group', featureIds: ['feat-1', 'feat-2'] };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        failedFeatureIds: expect.arrayContaining(['feat-2']),
      })
    );
  });

  it('400: feature status not backlog/ready (e.g. in_progress)', async () => {
    const { mockGroupService, mockFeatureLoader } = buildMocks({
      featureMap: {
        'feat-1': buildFeature('feat-1', 'in_progress'),
        'feat-2': buildFeature('feat-2'),
      },
    });
    req.body = { projectPath: '/test/proj', name: 'Test Group', featureIds: ['feat-1', 'feat-2'] };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        failedFeatureIds: expect.arrayContaining(['feat-1']),
      })
    );
  });

  it('409: GroupCommandDenied from engine.createGroup', async () => {
    const denial = new GroupCommandDenied('duplicate child IDs', {});
    const { mockGroupService, mockFeatureLoader } = buildMocks({ engineCreateThrows: denial });
    req.body = { projectPath: '/test/proj', name: 'Test Group', featureIds: ['feat-1', 'feat-2'] };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: denial.message, guard: denial.formatted })
    );
  });

  it('baseBranch write-back: feature without branchName gets baseBranch written', async () => {
    const { atomicWriteJson } = await import('@aboardai/utils');
    const atomicWriteJsonMock = vi.mocked(atomicWriteJson);

    const { mockGroupService, mockFeatureLoader } = buildMocks({
      featureMap: {
        // feat-1: no branchName (null) → baseBranch should be written
        'feat-1': { ...buildFeature('feat-1', 'backlog'), branchName: null },
        // feat-2: has branchName → should NOT be overwritten
        'feat-2': { ...buildFeature('feat-2', 'ready'), branchName: 'existing-branch' },
      },
    });
    req.body = {
      projectPath: '/test/proj',
      name: 'Test Group',
      baseBranch: 'main',
      featureIds: ['feat-1', 'feat-2'],
    };

    const handler = createCreateHandler(mockGroupService, mockFeatureLoader);
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // atomicWriteJson should have been called once for feat-1 (no branchName); feat-2 skipped
    expect(atomicWriteJsonMock).toHaveBeenCalledTimes(1);
    expect(atomicWriteJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('feat-1'),
      expect.objectContaining({ branchName: 'main' })
    );
  });
});
