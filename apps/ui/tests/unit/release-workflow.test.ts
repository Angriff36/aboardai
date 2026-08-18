import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop release workflow', () => {
  const workflow = readFileSync(
    resolve(__dirname, '../../../../.github/workflows/release.yml'),
    'utf8'
  );

  it('publishes Electron updater metadata with every desktop release', () => {
    expect(workflow).toContain('apps/ui/release/latest.yml');
    expect(workflow).toContain('apps/ui/release/latest-mac.yml');
    expect(workflow).toContain('apps/ui/release/latest-linux.yml');
    expect(workflow).toContain('apps/ui/release/*.blockmap');
    expect(workflow).toContain('artifacts/windows-builds/latest.yml');
    expect(workflow).toContain('artifacts/windows-builds/*.blockmap');
  });
});
