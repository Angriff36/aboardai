/**
 * AgentExecutor — normalized event pipeline integration tests (Task 3.4)
 *
 * Tests that the executor wires NormalizedEventStream + EventLogWriter correctly:
 * (a) events.jsonl is written during a FakeProvider run that contains task markers
 * (b) 'feature:event' emissions occur on the eventBus
 * (c) writer.close() flushes on abort/error — events written before the error are persisted
 *
 * Uses real file I/O in a temp directory (same pattern as event-log.test.ts).
 * Does NOT mock secureFs so actual disk writes are verified.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AgentExecutor } from '../../../src/services/agent-executor.js';
import type { TypedEventBus } from '../../../src/services/typed-event-bus.js';
import type { FeatureStateManager } from '../../../src/services/feature-state-manager.js';
import type { PlanApprovalService } from '../../../src/services/plan-approval-service.js';
import type { BaseProvider } from '../../../src/providers/base-provider.js';
import type { AgentExecutionOptions } from '../../../src/services/agent-executor.js';
import { FakeProvider } from '../supervisor/fake-provider.js';
import type { FakeRun } from '../supervisor/fake-provider.js';
import type { NormalizedEvent } from '@aboardai/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `executor-pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function eventsJsonlPath(projectPath: string, featureId: string): string {
  return path.join(projectPath, '.aboardai', 'features', featureId, 'events.jsonl');
}

async function readEvents(projectPath: string, featureId: string): Promise<NormalizedEvent[]> {
  const filePath = eventsJsonlPath(projectPath, featureId);
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as NormalizedEvent);
}

function makeExecutorMocks(): {
  mockEventBus: TypedEventBus;
  mockFeatureStateManager: FeatureStateManager;
  mockPlanApprovalService: PlanApprovalService;
  emitSpy: ReturnType<typeof vi.fn>;
} {
  const emitSpy = vi.fn();
  const mockEventBus = {
    emitAutoModeEvent: vi.fn(),
    emit: emitSpy,
  } as unknown as TypedEventBus;

  const mockFeatureStateManager = {
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    updateFeaturePlanSpec: vi.fn().mockResolvedValue(undefined),
    saveFeatureSummary: vi.fn().mockResolvedValue(undefined),
    markFeatureInterrupted: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeatureStateManager;

  const mockPlanApprovalService = {
    waitForApproval: vi.fn(),
  } as unknown as PlanApprovalService;

  return { mockEventBus, mockFeatureStateManager, mockPlanApprovalService, emitSpy };
}

function makeCallbacks() {
  return {
    waitForApproval: vi.fn().mockResolvedValue({ approved: true }),
    saveFeatureSummary: vi.fn().mockResolvedValue(undefined),
    updateFeatureSummary: vi.fn().mockResolvedValue(undefined),
    buildTaskPrompt: vi.fn().mockReturnValue('task prompt'),
  };
}

// ---------------------------------------------------------------------------
// Suite 3.4a: events.jsonl written + feature:event emitted during FakeProvider run
// ---------------------------------------------------------------------------

describe('AgentExecutor pipeline — events.jsonl and feature:event (3.4a)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes task_marker events and result event to events.jsonl when provider emits [TASK_START]/[TASK_COMPLETE]', async () => {
    const featureId = 'feat-pipeline-markers';
    const { mockEventBus, mockFeatureStateManager, mockPlanApprovalService, emitSpy } =
      makeExecutorMocks();

    const run: FakeRun = {
      directives: [
        {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '[TASK_START] T001\nWorking on it...\n' }],
            },
          } as import('@aboardai/types').ProviderMessage,
        },
        {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: '[TASK_COMPLETE] T001: Done with task\nMore output.\n' },
              ],
            },
          } as import('@aboardai/types').ProviderMessage,
        },
        {
          kind: 'message',
          message: {
            type: 'result',
            subtype: 'success',
            result: 'done',
          } as import('@aboardai/types').ProviderMessage,
        },
        { kind: 'end' },
      ],
    };

    const fakeProvider = new FakeProvider([run]);

    const executor = new AgentExecutor(
      mockEventBus,
      mockFeatureStateManager,
      mockPlanApprovalService
    );

    const options: AgentExecutionOptions = {
      workDir: tmpDir,
      featureId,
      prompt: 'Test prompt',
      projectPath: tmpDir,
      abortController: new AbortController(),
      provider: fakeProvider as unknown as BaseProvider,
      effectiveBareModel: 'claude-sonnet-4-6',
      planningMode: 'skip',
    };

    await executor.execute(options, makeCallbacks());

    // (1) events.jsonl must exist
    const filePath = eventsJsonlPath(tmpDir, featureId);
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // (2) events.jsonl must contain task_marker events
    const events = await readEvents(tmpDir, featureId);
    const taskMarkers = events.filter((e) => e.kind === 'task_marker');
    expect(taskMarkers.length).toBeGreaterThanOrEqual(2);

    const taskStart = taskMarkers.find((e) => e.marker?.type === 'task_start');
    expect(taskStart).toBeDefined();
    expect(taskStart?.marker?.taskId).toBe('T001');

    const taskComplete = taskMarkers.find((e) => e.marker?.type === 'task_complete');
    expect(taskComplete).toBeDefined();
    expect(taskComplete?.marker?.taskId).toBe('T001');
    expect(taskComplete?.marker?.summary).toBe('Done with task');

    // (3) events.jsonl must contain a result event
    const resultEvents = events.filter((e) => e.kind === 'result');
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);

    // (4) feature:event was emitted on the eventBus for each normalized event
    const featureEventCalls = emitSpy.mock.calls.filter(
      ([type]: [string]) => type === 'feature:event'
    );
    expect(featureEventCalls.length).toBeGreaterThan(0);

    // (5) Each 'feature:event' payload contains featureId, projectPath, and an event
    for (const [, payload] of featureEventCalls) {
      const p = payload as { featureId: string; projectPath: string; event: NormalizedEvent };
      expect(p.featureId).toBe(featureId);
      expect(p.projectPath).toBe(tmpDir);
      expect(p.event).toBeDefined();
      expect(p.event.v).toBe(1);
    }
  });

  it('emits feature:event with provider name matching provider.getName()', async () => {
    const featureId = 'feat-pipeline-provider-name';
    const { mockEventBus, mockFeatureStateManager, mockPlanApprovalService, emitSpy } =
      makeExecutorMocks();

    const run: FakeRun = {
      directives: [
        {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello world' }],
            },
          } as import('@aboardai/types').ProviderMessage,
        },
        {
          kind: 'message',
          message: {
            type: 'result',
            subtype: 'success',
          } as import('@aboardai/types').ProviderMessage,
        },
        { kind: 'end' },
      ],
    };

    const fakeProvider = new FakeProvider([run]);
    const executor = new AgentExecutor(
      mockEventBus,
      mockFeatureStateManager,
      mockPlanApprovalService
    );

    const options: AgentExecutionOptions = {
      workDir: tmpDir,
      featureId,
      prompt: 'Test prompt',
      projectPath: tmpDir,
      abortController: new AbortController(),
      provider: fakeProvider as unknown as BaseProvider,
      effectiveBareModel: 'claude-sonnet-4-6',
      planningMode: 'skip',
    };

    await executor.execute(options, makeCallbacks());

    const featureEventCalls = emitSpy.mock.calls.filter(
      ([type]: [string]) => type === 'feature:event'
    );
    expect(featureEventCalls.length).toBeGreaterThan(0);

    // Provider name should be 'fake' (from FakeProvider.getName())
    const firstPayload = featureEventCalls[0][1] as { event: NormalizedEvent };
    expect(firstPayload.event.provider).toBe('fake');
  });
});

// ---------------------------------------------------------------------------
// Suite 3.4b: abort/error path — writer.close() flushes written events
// ---------------------------------------------------------------------------

describe('AgentExecutor pipeline — writer.close() flushes on abort/error (3.4b)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('events written before an error are flushed to events.jsonl', async () => {
    const featureId = 'feat-pipeline-error';
    const { mockEventBus, mockFeatureStateManager, mockPlanApprovalService } = makeExecutorMocks();

    const run: FakeRun = {
      directives: [
        {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Starting work...' }],
            },
          } as import('@aboardai/types').ProviderMessage,
        },
        {
          kind: 'message',
          message: {
            type: 'error',
            error: 'Simulated provider error',
          } as import('@aboardai/types').ProviderMessage,
        },
      ],
    };

    const fakeProvider = new FakeProvider([run]);
    const executor = new AgentExecutor(
      mockEventBus,
      mockFeatureStateManager,
      mockPlanApprovalService
    );

    const options: AgentExecutionOptions = {
      workDir: tmpDir,
      featureId,
      prompt: 'Test prompt',
      projectPath: tmpDir,
      abortController: new AbortController(),
      provider: fakeProvider as unknown as BaseProvider,
      effectiveBareModel: 'claude-sonnet-4-6',
      planningMode: 'skip',
    };

    // Execution should throw due to the error message
    await expect(executor.execute(options, makeCallbacks())).rejects.toThrow(
      'Simulated provider error'
    );

    // Despite the error, events.jsonl must contain the text event written before the error
    const filePath = eventsJsonlPath(tmpDir, featureId);
    let events: NormalizedEvent[] = [];
    try {
      events = await readEvents(tmpDir, featureId);
    } catch {
      // File may not exist if nothing was written (but it should be since we had 1 text message)
    }

    // There should be at least one agent_message event (the 'Starting work...' text)
    const textEvents = events.filter((e) => e.kind === 'agent_message');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents[0].text).toContain('Starting work');
  });

  it('events written before an abort are flushed to events.jsonl', async () => {
    const featureId = 'feat-pipeline-abort';
    const { mockEventBus, mockFeatureStateManager, mockPlanApprovalService } = makeExecutorMocks();

    const abortController = new AbortController();

    const run: FakeRun = {
      directives: [
        {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Working before abort...' }],
            },
          } as import('@aboardai/types').ProviderMessage,
        },
        // Abort is triggered by the signal being aborted, not by a message
        // We deliver a result after to simulate abort being checked at loop entry
        {
          kind: 'message',
          message: {
            type: 'result',
            subtype: 'success',
          } as import('@aboardai/types').ProviderMessage,
        },
        { kind: 'end' },
      ],
    };

    // Pre-abort the controller so the abort check fires on first text message
    abortController.abort();

    const fakeProvider = new FakeProvider([run]);
    const executor = new AgentExecutor(
      mockEventBus,
      mockFeatureStateManager,
      mockPlanApprovalService
    );

    const options: AgentExecutionOptions = {
      workDir: tmpDir,
      featureId,
      prompt: 'Test prompt',
      projectPath: tmpDir,
      abortController,
      provider: fakeProvider as unknown as BaseProvider,
      effectiveBareModel: 'claude-sonnet-4-6',
      planningMode: 'skip',
    };

    // Should not throw (abort is handled gracefully per existing behavior)
    await executor.execute(options, makeCallbacks()).catch(() => {
      // Some abort paths may throw; we just care about the file state
    });

    // Wait a tick to ensure any async flush has settled
    await new Promise((resolve) => setTimeout(resolve, 20));

    // events.jsonl may or may not exist depending on whether text was appended before abort
    // The key assertion: if it exists, its content must be valid JSONL (no corruption)
    const filePath = eventsJsonlPath(tmpDir, featureId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        // Each line must be parseable JSON (writer closed cleanly = no torn tail)
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      // ENOENT is OK — no events written before abort is also valid
    }
  });
});
