import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodexConfigManager } from '@/providers/codex-config-manager.js';
import { secureFs } from '@aboardai/platform';
import type { McpServerConfig } from '@aboardai/types';

vi.mock('@aboardai/platform', () => ({
  secureFs: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn(),
  },
}));

describe('CodexConfigManager', () => {
  const manager = new CodexConfigManager();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips in-process sdk servers so Codex never sees an invalid transport', async () => {
    const servers: Record<string, McpServerConfig> = {
      aboardai: { type: 'sdk', name: 'aboardai', instance: {} },
      designmd: { type: 'stdio', command: 'npx', args: ['designmd-mcp'] },
    };

    await manager.configureMcpServers('/proj', servers);

    expect(secureFs.writeFile).toHaveBeenCalledTimes(1);
    const content = vi.mocked(secureFs.writeFile).mock.calls[0][1] as string;
    expect(content).toContain('mcp_servers."designmd"');
    expect(content).not.toContain('aboardai');
    expect(content).not.toContain('sdk');
  });

  it('removes a stale config when only sdk servers are configured', async () => {
    const servers: Record<string, McpServerConfig> = {
      aboardai: { type: 'sdk', name: 'aboardai', instance: {} },
    };

    await manager.configureMcpServers('/proj', servers);

    expect(secureFs.writeFile).not.toHaveBeenCalled();
    expect(secureFs.rm).toHaveBeenCalledTimes(1);
  });
});
