import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  it('builds artifacts without electron-builder trying to publish them a second time', () => {
    const parsed = parse(workflow) as {
      jobs: { build: { steps: Array<{ name?: string; run?: string }> } };
    };
    const desktopBuilds = parsed.jobs.build.steps.filter((step) =>
      step.name?.startsWith('Build Electron app')
    );

    expect(desktopBuilds).toHaveLength(3);
    expect(desktopBuilds.map((step) => step.run)).toEqual([
      'npm run build:electron:mac --workspace=apps/ui -- --publish never',
      'npm run build:electron:win --workspace=apps/ui -- --publish never',
      'npm run build:electron:linux --workspace=apps/ui -- --publish never',
    ]);
  });
});
