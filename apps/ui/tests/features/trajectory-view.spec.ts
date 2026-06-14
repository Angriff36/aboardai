/**
 * Trajectory View E2E Test
 *
 * Verifies that the agent-output modal opens with the Trajectory tab selected
 * by default and renders grouped activity when events.jsonl exists for a feature.
 *
 * Mirrors setup from: tests/features/responsive/agent-output-modal-responsive.spec.ts
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTempDirPath,
  cleanupTempDir,
  setupRealProject,
  waitForNetworkIdle,
  authenticateForTests,
  handleLoginScreenIfPresent,
  dismissSandboxWarningIfVisible,
} from '../utils';

const TEST_TEMP_DIR = createTempDirPath('trajectory-view-test');

/**
 * Create a verified feature on disk with an agent-output.md AND an events.jsonl
 * so the trajectory view has events to display.
 */
function createVerifiedFeatureWithEvents(
  projectPath: string,
  featureId: string,
  description: string
): void {
  const featureDir = path.join(projectPath, '.aboardai', 'features', featureId);
  fs.mkdirSync(featureDir, { recursive: true });

  // Write agent-output.md so the "Logs" button appears on the kanban card
  fs.writeFileSync(
    path.join(featureDir, 'agent-output.md'),
    `## Summary\nFeature implemented successfully.\n\n## Details\n${description}`,
    { encoding: 'utf-8' }
  );

  // Write feature.json with status 'verified'
  fs.writeFileSync(
    path.join(featureDir, 'feature.json'),
    JSON.stringify(
      {
        id: featureId,
        title: description,
        category: 'default',
        description,
        status: 'verified',
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  );

  // Write events.jsonl so the trajectory store has events to render.
  // Each line is a NormalizedEvent (v=1) written as JSONL.
  // We write two agent_message events so groupTrajectory creates at least one group
  // (they'll be in the default 'Activity' group since no task_marker events precede them).
  const now = new Date().toISOString();
  const events = [
    {
      v: 1,
      id: '0001',
      ts: now,
      kind: 'agent_message',
      provider: 'claude',
      featureId,
      text: 'Starting implementation...',
    },
    {
      v: 1,
      id: '0002',
      ts: now,
      kind: 'tool_use',
      provider: 'claude',
      featureId,
      tool: { name: 'Write', inputPreview: 'src/index.ts' },
    },
    {
      v: 1,
      id: '0003',
      ts: now,
      kind: 'result',
      provider: 'claude',
      featureId,
      result: { subtype: 'success', isError: false },
    },
  ];
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(featureDir, 'events.jsonl'), jsonl, { encoding: 'utf-8' });
}

test.describe('Trajectory View', () => {
  let projectPath: string;
  const projectName = `test-trajectory-${Date.now()}`;

  test.beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    projectPath = path.join(TEST_TEMP_DIR, projectName);
    fs.mkdirSync(projectPath, { recursive: true });

    fs.writeFileSync(
      path.join(projectPath, 'package.json'),
      JSON.stringify({ name: projectName, version: '1.0.0' }, null, 2)
    );

    const aboardaiDir = path.join(projectPath, '.aboardai');
    fs.mkdirSync(path.join(aboardaiDir, 'features'), { recursive: true });
    fs.mkdirSync(path.join(aboardaiDir, 'context'), { recursive: true });

    fs.writeFileSync(
      path.join(aboardaiDir, 'categories.json'),
      JSON.stringify({ categories: [] }, null, 2)
    );

    fs.writeFileSync(
      path.join(aboardaiDir, 'app_spec.txt'),
      `# ${projectName}\n\nA test project for trajectory view testing.`
    );
  });

  test.afterAll(async () => {
    cleanupTempDir(TEST_TEMP_DIR);
  });

  test('agent output modal opens on the Trajectory tab and shows grouped activity', async ({
    page,
  }) => {
    const featureId = `trajectory-feat-${Date.now()}`;
    createVerifiedFeatureWithEvents(projectPath, featureId, 'Trajectory test feature');

    await setupRealProject(page, projectPath, projectName, { setAsCurrent: true });
    await authenticateForTests(page);
    await page.goto('/board');
    await page.waitForLoadState('load');
    await handleLoginScreenIfPresent(page);
    await waitForNetworkIdle(page);

    await expect(page.locator('[data-testid="board-view"]')).toBeVisible({ timeout: 10000 });

    // Dismiss sandbox warning dialog if it appears (blocks pointer events)
    await dismissSandboxWarningIfVisible(page);

    // Wait for the verified feature card to appear
    const featureCard = page.locator(`[data-testid="kanban-card-${featureId}"]`);
    await expect(featureCard).toBeVisible({ timeout: 10000 });

    // Click the Logs button on the verified feature card to open the output modal
    const logsButton = page.locator(`[data-testid="view-output-verified-${featureId}"]`);
    await expect(logsButton).toBeVisible({ timeout: 5000 });
    await logsButton.click();

    // Wait for the modal to open
    await expect(page.locator('[data-testid="agent-output-modal"]')).toBeVisible({
      timeout: 10000,
    });

    // Assert: Trajectory tab is selected by default (has the active bg-primary/20 class)
    const trajectoryTab = page.getByTestId('view-mode-trajectory');
    await expect(trajectoryTab).toBeVisible({ timeout: 5000 });
    await expect(trajectoryTab).toHaveClass(/bg-primary\/20/);

    // Assert: at least one phase group is present (rendered by TrajectoryView)
    // Phase groups have data-testid="phase-<title>", so [data-testid^="phase-"] matches them.
    await expect(page.locator('[data-testid^="phase-"]').first()).toBeVisible({ timeout: 5000 });
  });
});
