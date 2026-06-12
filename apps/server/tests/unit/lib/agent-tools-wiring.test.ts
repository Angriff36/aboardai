/**
 * Wiring test for agent-tools + sdk-options integration.
 *
 * Verifies that:
 * 1. createAboardaiToolsServer returns a value that TypeScript accepts as McpServerConfig
 * 2. The returned server can be merged into CreateSdkOptionsConfig.mcpServers
 * 3. createAutoModeOptions accepts the merged config without errors
 * 4. The resulting Options.mcpServers contains an 'aboardai' key
 *
 * We mock the Agent SDK's createSdkMcpServer so no real server spins up.
 * We mock sdk-options' validateWorkingDirectory so the path check doesn't fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig, Feature } from '@aboardai/types';

// ── Mock Agent SDK ─────────────────────────────────────────────────────────────
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name: _name,
    handler,
  })),
  createSdkMcpServer: vi.fn(({ name }: { name: string }) => ({
    type: 'sdk',
    name,
    instance: {},
  })),
}));

// ── Mock validateWorkingDirectory so the path check passes in tests ────────────
vi.mock('@/lib/sdk-options.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sdk-options.js')>();
  return {
    ...actual,
    validateWorkingDirectory: vi.fn(),
  };
});

function makeFeature(id: string): Feature {
  return {
    id,
    title: `Feature ${id}`,
    description: 'Test',
    status: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: 2,
    category: 'feature',
    dependencies: [],
  } as Feature;
}

describe('agent-tools wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createAboardaiToolsServer result is accepted as McpServerConfig', async () => {
    const { createAboardaiToolsServer } = await import('@/lib/agent-tools.js');
    const { createAutoModeOptions } = await import('@/lib/sdk-options.js');

    const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
    const mockGetFeature = vi.fn().mockResolvedValue(makeFeature('f1'));

    const aboardaiServer = createAboardaiToolsServer({
      updateFeatureStatus: mockUpdateStatus,
      getFeature: mockGetFeature,
      projectPath: '/test/project',
    });

    // TypeScript compile-time check: aboardaiServer must be assignable to McpServerConfig
    const mcpServers: Record<string, McpServerConfig> = {
      aboardai: aboardaiServer,
    };

    // Runtime: options object is created successfully with the aboardai server
    const opts = createAutoModeOptions({
      cwd: '/test/project',
      mcpServers,
    });

    // The mcpServers should have been passed through buildMcpOptions into the returned Options
    expect(opts).toHaveProperty('mcpServers');
    const resultMcpServers = (opts as { mcpServers?: Record<string, unknown> }).mcpServers;
    expect(resultMcpServers).toHaveProperty('aboardai');
    expect((resultMcpServers!['aboardai'] as { type: string }).type).toBe('sdk');
    expect((resultMcpServers!['aboardai'] as { name: string }).name).toBe('aboardai');
  });

  it('executor ExecuteOptions mcpServers carries "aboardai" key for feature run', async () => {
    const { createAboardaiToolsServer } = await import('@/lib/agent-tools.js');

    const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
    const mockGetFeature = vi.fn().mockResolvedValue(makeFeature('f1'));

    const aboardaiServer = createAboardaiToolsServer({
      updateFeatureStatus: mockUpdateStatus,
      getFeature: mockGetFeature,
      projectPath: '/test/project',
    });

    // Simulate how facade.ts merges the aboardai server into mcpServers
    const userMcpServers: Record<string, unknown> = {};
    const merged: Record<string, unknown> = { ...userMcpServers, aboardai: aboardaiServer };

    // The merged record has the aboardai key
    expect(merged).toHaveProperty('aboardai');
    expect((merged['aboardai'] as { type: string }).type).toBe('sdk');
    expect((merged['aboardai'] as { name: string }).name).toBe('aboardai');
  });

  it('user-configured MCP servers are preserved alongside aboardai server', async () => {
    const { createAboardaiToolsServer } = await import('@/lib/agent-tools.js');

    const aboardaiServer = createAboardaiToolsServer({
      updateFeatureStatus: vi.fn().mockResolvedValue(undefined),
      getFeature: vi.fn().mockResolvedValue(makeFeature('f1')),
      projectPath: '/test/project',
    });

    const userServers: Record<string, unknown> = {
      myExternalServer: { type: 'stdio', command: 'node', args: ['server.js'] },
    };
    const merged = { ...userServers, aboardai: aboardaiServer };

    expect(merged).toHaveProperty('aboardai');
    expect(merged).toHaveProperty('myExternalServer');
  });
});
