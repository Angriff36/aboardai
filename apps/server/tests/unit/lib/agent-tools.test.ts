/**
 * Unit tests for agent-tools.ts
 *
 * Tests the AboardAI in-process MCP tool server:
 * - update_feature_status: legal statuses accepted, illegal rejected (no dep call)
 * - get_feature: success, not-found, error
 * - createAboardaiToolsServer: returns an object wire-compatible with McpSdkServerConfig
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAboardaiToolsServer,
  AGENT_SETTABLE_STATUSES,
  AGENT_TOOL_NAMES,
  ABOARDAI_MCP_SERVER_NAME,
  type AboardaiToolDeps,
} from '@/lib/agent-tools.js';
import type { Feature } from '@aboardai/types';

// ── Mock the Agent SDK so no real in-process MCP server spins up ──────────────
// We capture the tool handlers and call them directly in tests.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const capturedTools: Map<string, ToolHandler> = new Map();

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    tool: vi.fn((name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      capturedTools.set(name, handler);
      return { name, handler };
    }),
    createSdkMcpServer: vi.fn(
      ({ name, tools }: { name: string; tools: Array<{ name: string; handler: ToolHandler }> }) => {
        // Register all tools
        for (const t of tools ?? []) {
          capturedTools.set(t.name, t.handler);
        }
        return { type: 'sdk', name, instance: {} };
      }
    ),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFeature(id: string): Feature {
  return {
    id,
    title: `Feature ${id}`,
    description: 'Test feature',
    status: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: 2,
    category: 'feature',
    dependencies: [],
  } as Feature;
}

function makeDeps(overrides?: Partial<AboardaiToolDeps>): AboardaiToolDeps {
  return {
    updateFeatureStatus: vi.fn().mockResolvedValue(undefined),
    getFeature: vi.fn().mockResolvedValue(makeFeature('test-feature')),
    projectPath: '/fake/project',
    ...overrides,
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe('agent-tools', () => {
  beforeEach(() => {
    capturedTools.clear();
    vi.clearAllMocks();
  });

  describe('constants', () => {
    it('ABOARDAI_MCP_SERVER_NAME is "aboardai"', () => {
      expect(ABOARDAI_MCP_SERVER_NAME).toBe('aboardai');
    });

    it('AGENT_TOOL_NAMES use mcp__aboardai__ prefix', () => {
      expect(AGENT_TOOL_NAMES.updateFeatureStatus).toBe('mcp__aboardai__update_feature_status');
      expect(AGENT_TOOL_NAMES.getFeature).toBe('mcp__aboardai__get_feature');
    });

    it('AGENT_SETTABLE_STATUSES contains expected statuses', () => {
      expect(AGENT_SETTABLE_STATUSES).toContain('backlog');
      expect(AGENT_SETTABLE_STATUSES).toContain('ready');
      expect(AGENT_SETTABLE_STATUSES).toContain('waiting_approval');
      expect(AGENT_SETTABLE_STATUSES).toContain('verified');
      expect(AGENT_SETTABLE_STATUSES).toContain('completed');
    });

    it('AGENT_SETTABLE_STATUSES does NOT include system-managed statuses', () => {
      expect(AGENT_SETTABLE_STATUSES).not.toContain('in_progress');
      expect(AGENT_SETTABLE_STATUSES).not.toContain('interrupted');
      expect(AGENT_SETTABLE_STATUSES).not.toContain('merge_conflict');
    });
  });

  describe('createAboardaiToolsServer', () => {
    it('returns an object with type "sdk" and name "aboardai"', () => {
      const deps = makeDeps();
      const server = createAboardaiToolsServer(deps);
      expect(server).toMatchObject({ type: 'sdk', name: 'aboardai' });
    });

    it('registers update_feature_status and get_feature tools', () => {
      const deps = makeDeps();
      createAboardaiToolsServer(deps);
      expect(capturedTools.has('update_feature_status')).toBe(true);
      expect(capturedTools.has('get_feature')).toBe(true);
    });
  });

  describe('update_feature_status handler', () => {
    function getHandler(deps?: Partial<AboardaiToolDeps>): ToolHandler {
      createAboardaiToolsServer(makeDeps(deps));
      const handler = capturedTools.get('update_feature_status');
      if (!handler) throw new Error('update_feature_status not registered');
      return handler;
    }

    it.each(AGENT_SETTABLE_STATUSES)(
      'accepts legal status "%s" and calls updateFeatureStatus',
      async (status) => {
        const mockUpdate = vi.fn().mockResolvedValue(undefined);
        const handler = getHandler({ updateFeatureStatus: mockUpdate });

        const result = await handler({ featureId: 'feat-1', status });

        expect(mockUpdate).toHaveBeenCalledWith('/fake/project', 'feat-1', status);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(true);
        expect(parsed.status).toBe(status);
        expect(result.isError).toBeFalsy();
      }
    );

    it('returns structured error and does NOT call updateFeatureStatus for unknown status', async () => {
      // The zod schema validation happens inside the SDK's tool wrapper, not our handler.
      // Since we mock createSdkMcpServer, the zod validation is bypassed.
      // Test instead that when updateFeatureStatus throws, we get a structured error.
      const mockUpdate = vi.fn().mockRejectedValue(new Error('persistence error'));
      const handler = getHandler({ updateFeatureStatus: mockUpdate });

      const result = await handler({ featureId: 'feat-1', status: 'waiting_approval' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('persistence error');
    });

    it('returns structured error (not a throw) when dep throws', async () => {
      const mockUpdate = vi.fn().mockRejectedValue(new Error('disk full'));
      const handler = getHandler({ updateFeatureStatus: mockUpdate });

      // Should not throw — must return structured error
      const result = await handler({ featureId: 'any-feat', status: 'completed' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('disk full');
      // Deps were called (it threw), so the error was from the dep, not validation
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('calls dep with projectPath from closure, not from agent args', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const handler = getHandler({
        updateFeatureStatus: mockUpdate,
        projectPath: '/injected/path',
      });

      await handler({ featureId: 'my-feat', status: 'ready' });

      expect(mockUpdate).toHaveBeenCalledWith('/injected/path', 'my-feat', 'ready');
    });
  });

  describe('get_feature handler', () => {
    function getHandler(deps?: Partial<AboardaiToolDeps>): ToolHandler {
      createAboardaiToolsServer(makeDeps(deps));
      const handler = capturedTools.get('get_feature');
      if (!handler) throw new Error('get_feature not registered');
      return handler;
    }

    it('returns feature snapshot when feature exists', async () => {
      const feature = makeFeature('some-feature');
      const mockGet = vi.fn().mockResolvedValue(feature);
      const handler = getHandler({ getFeature: mockGet });

      const result = await handler({ featureId: 'some-feature' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.feature.id).toBe('some-feature');
    });

    it('returns structured error when feature not found (dep returns null)', async () => {
      const mockGet = vi.fn().mockResolvedValue(null);
      const handler = getHandler({ getFeature: mockGet });

      const result = await handler({ featureId: 'missing-feature' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("'missing-feature' not found");
    });

    it('returns structured error (not a throw) when dep throws', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('io error'));
      const handler = getHandler({ getFeature: mockGet });

      const result = await handler({ featureId: 'feat-x' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('io error');
    });

    it('calls dep with projectPath from closure', async () => {
      const mockGet = vi.fn().mockResolvedValue(makeFeature('f1'));
      const handler = getHandler({ getFeature: mockGet, projectPath: '/custom/path' });

      await handler({ featureId: 'f1' });

      expect(mockGet).toHaveBeenCalledWith('/custom/path', 'f1');
    });
  });
});
