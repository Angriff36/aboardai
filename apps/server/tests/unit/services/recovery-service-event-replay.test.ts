/**
 * Recovery-service event-replay integration tests (Task 4.2)
 *
 * Tests the new events.jsonl replay path in RecoveryService.resumeFeature():
 *  1. When events.jsonl has ≥1 event, context is built from renderEventsToContext().
 *  2. The rendered context contains task_marker sentinel lines and recent messages.
 *  3. A torn-tail events.jsonl (readEventLog tolerant) still resumes successfully.
 *  4. When events.jsonl is absent/empty, the existing agent-output.md path is used (fallback).
 *
 * Mocking strategy:
 *  - Mock @/lib/secure-fs.js for agent-output.md reads (existing pattern).
 *  - Mock @/services/recovery-service's imported event-log and event-renderer
 *    modules via vi.mock() so we can control readEventLog() return values.
 *  - The renderer is tested in depth by event-renderer.test.ts; here we test
 *    only that the correct branch is taken and the output is threaded into the
 *    continuation prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecoveryService } from '@/services/recovery-service.js';
import type { Feature } from '@aboardai/types';
import type { NormalizedEvent } from '@aboardai/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@aboardai/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  readJsonWithRecovery: vi.fn().mockResolvedValue({ data: null, wasRecovered: false }),
  logRecoveryWarning: vi.fn(),
  DEFAULT_BACKUP_COUNT: 5,
}));

vi.mock('@aboardai/platform', () => ({
  getFeatureDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.aboardai/features/${featureId}`,
  getFeaturesDir: (projectPath: string) => `${projectPath}/.aboardai/features`,
  getExecutionStatePath: (projectPath: string) => `${projectPath}/.aboardai/execution-state.json`,
  ensureAboardAIDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/secure-fs.js', () => ({
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/settings-helpers.js', () => ({
  getPromptCustomization: vi.fn().mockResolvedValue({
    taskExecution: {
      resumeFeatureTemplate: 'Resume: {{featurePrompt}}\n\nPrevious context:\n{{previousContext}}',
      implementationInstructions: '',
      playwrightVerificationInstructions: '',
    },
  }),
}));

// Mock the event-log and renderer as imported by recovery-service
vi.mock('@/events/event-log.js', () => ({
  readEventLog: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/events/event-renderer.js', () => ({
  renderEventsToContext: vi.fn().mockReturnValue(''),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'feature-1',
    title: 'Test Feature',
    description: 'A test feature',
    status: 'in_progress',
    ...overrides,
  };
}

/** Build a representative NormalizedEvent array with markers + messages */
function makeEventLog(): NormalizedEvent[] {
  return [
    {
      v: 1,
      id: '0001',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'agent_message',
      provider: 'claude',
      text: 'Starting task implementation.',
    },
    {
      v: 1,
      id: '0002',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'task_marker',
      provider: 'claude',
      marker: { type: 'task_start', taskId: 'T001' },
    },
    {
      v: 1,
      id: '0003',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'file_edit',
      provider: 'claude',
      file: { path: 'src/feature.ts', tool: 'Edit' },
    },
    {
      v: 1,
      id: '0004',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'task_marker',
      provider: 'claude',
      marker: { type: 'task_complete', taskId: 'T001', summary: 'feature scaffolded' },
    },
    {
      v: 1,
      id: '0005',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'agent_message',
      provider: 'claude',
      text: 'All tasks complete.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('RecoveryService — event replay (Task 4.2)', () => {
  let secureFs: typeof import('@/lib/secure-fs.js');
  let eventLog: typeof import('@/events/event-log.js');
  let eventRenderer: typeof import('@/events/event-renderer.js');

  const mockEventBus = {
    emitAutoModeEvent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };

  const mockConcurrencyManager = {
    getAllRunning: vi.fn().mockReturnValue([]),
    getRunningFeature: vi.fn().mockReturnValue(null),
    acquire: vi.fn().mockImplementation(({ featureId }: { featureId: string }) => ({
      featureId,
      abortController: new AbortController(),
      projectPath: '/test/project',
      isAutoMode: false,
      startTime: Date.now(),
      leaseCount: 1,
    })),
    release: vi.fn(),
    getRunningCountForWorktree: vi.fn().mockReturnValue(0),
  };

  let mockExecuteFeature: ReturnType<typeof vi.fn>;
  let mockLoadFeature: ReturnType<typeof vi.fn>;
  let mockDetectPipelineStatus: ReturnType<typeof vi.fn>;
  let mockResumePipeline: ReturnType<typeof vi.fn>;
  let mockIsFeatureRunning: ReturnType<typeof vi.fn>;
  let mockAcquireRunningFeature: ReturnType<typeof vi.fn>;
  let mockReleaseRunningFeature: ReturnType<typeof vi.fn>;

  let service: RecoveryService;

  beforeEach(async () => {
    vi.clearAllMocks();

    secureFs = await import('@/lib/secure-fs.js');
    eventLog = await import('@/events/event-log.js');
    eventRenderer = await import('@/events/event-renderer.js');

    // Re-apply settings-helpers mock after clearAllMocks() resets it
    const settingsHelpers = await import('@/lib/settings-helpers.js');
    vi.mocked(settingsHelpers.getPromptCustomization).mockResolvedValue({
      taskExecution: {
        resumeFeatureTemplate:
          'Resume: {{featurePrompt}}\n\nPrevious context:\n{{previousContext}}',
        implementationInstructions: '',
        playwrightVerificationInstructions: '',
      },
    } as any);

    // Default secureFs behavior: agent-output.md exists and has content
    vi.mocked(secureFs.access).mockResolvedValue(undefined);
    vi.mocked(secureFs.readFile).mockResolvedValue('agent-output.md content' as any);
    vi.mocked(secureFs.writeFile).mockResolvedValue(undefined);
    vi.mocked(secureFs.unlink).mockResolvedValue(undefined);
    vi.mocked(secureFs.readdir).mockResolvedValue([]);

    // Default event log: empty (fallback to agent-output.md)
    vi.mocked(eventLog.readEventLog).mockResolvedValue([]);

    // Default renderer: pass-through stub
    vi.mocked(eventRenderer.renderEventsToContext).mockReturnValue('rendered context from events');

    mockExecuteFeature = vi.fn().mockResolvedValue(undefined);
    mockLoadFeature = vi.fn().mockResolvedValue(makeFeature());
    mockDetectPipelineStatus = vi.fn().mockResolvedValue({
      isPipeline: false,
      stepId: null,
      stepIndex: -1,
      totalSteps: 0,
      step: null,
      config: null,
    });
    mockResumePipeline = vi.fn().mockResolvedValue(undefined);
    mockIsFeatureRunning = vi.fn().mockReturnValue(false);
    mockAcquireRunningFeature = vi
      .fn()
      .mockImplementation(({ featureId }: { featureId: string }) => ({
        featureId,
        abortController: new AbortController(),
      }));
    mockReleaseRunningFeature = vi.fn();

    service = new RecoveryService(
      mockEventBus as any,
      mockConcurrencyManager as any,
      null,
      mockExecuteFeature,
      mockLoadFeature,
      mockDetectPipelineStatus,
      mockResumePipeline,
      mockIsFeatureRunning,
      mockAcquireRunningFeature,
      mockReleaseRunningFeature
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: events.jsonl with ≥1 event → replay path used
  // -------------------------------------------------------------------------

  it('uses events.jsonl replay when readEventLog returns ≥1 event', async () => {
    const events = makeEventLog();
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce(events);
    vi.mocked(eventRenderer.renderEventsToContext).mockReturnValueOnce(
      'rendered: [TASK_START] T001\nAll tasks complete.'
    );

    await service.resumeFeature('/test/project', 'feature-1');

    // readEventLog should have been called
    expect(eventLog.readEventLog).toHaveBeenCalledWith('/test/project', 'feature-1');
    // renderEventsToContext should have been called with the event array
    expect(eventRenderer.renderEventsToContext).toHaveBeenCalledWith(events);
    // executeFeature called with the rendered context, NOT agent-output.md content
    expect(mockExecuteFeature).toHaveBeenCalledWith(
      '/test/project',
      'feature-1',
      false,
      false,
      undefined,
      expect.objectContaining({
        continuationPrompt: expect.stringContaining('[TASK_START] T001'),
        _calledInternally: true,
      })
    );
    // agent-output.md must NOT have been read via secureFs.readFile in this path
    // (readFile is used for execution-state only in this test — checking the call count)
    const readFileCalls = vi.mocked(secureFs.readFile).mock.calls;
    const agentOutputCalls = readFileCalls.filter((call) =>
      String(call[0]).includes('agent-output.md')
    );
    expect(agentOutputCalls).toHaveLength(0);
  });

  it('continuation prompt contains marker lines and recent agent messages', async () => {
    const events = makeEventLog();
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce(events);

    // Use the real renderer for this assertion
    const { renderEventsToContext: realRenderer } = await vi.importActual<
      typeof import('@/events/event-renderer.js')
    >('@/events/event-renderer.js');
    vi.mocked(eventRenderer.renderEventsToContext).mockImplementationOnce(realRenderer);

    await service.resumeFeature('/test/project', 'feature-1');

    const prompt = mockExecuteFeature.mock.calls[0][5].continuationPrompt as string;

    // Marker lines must appear verbatim
    expect(prompt).toContain('[TASK_START] T001');
    expect(prompt).toContain('[TASK_COMPLETE] T001: feature scaffolded');
    // Recent agent message
    expect(prompt).toContain('All tasks complete.');
  });

  // -------------------------------------------------------------------------
  // Test 2: Fallback — no events.jsonl (empty log) → agent-output.md used
  // -------------------------------------------------------------------------

  it('falls back to agent-output.md when readEventLog returns empty array', async () => {
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce([]);
    vi.mocked(secureFs.readFile).mockResolvedValueOnce('Previous agent output content' as any);

    await service.resumeFeature('/test/project', 'feature-1');

    // agent-output.md read via secureFs.readFile
    const readFileCalls = vi.mocked(secureFs.readFile).mock.calls;
    const agentOutputCalls = readFileCalls.filter((call) =>
      String(call[0]).includes('agent-output.md')
    );
    expect(agentOutputCalls).toHaveLength(1);

    // executeFeature called with agent-output.md content
    expect(mockExecuteFeature).toHaveBeenCalledWith(
      '/test/project',
      'feature-1',
      false,
      false,
      undefined,
      expect.objectContaining({
        continuationPrompt: expect.stringContaining('Previous agent output content'),
        _calledInternally: true,
      })
    );

    // renderEventsToContext must NOT have been called
    expect(eventRenderer.renderEventsToContext).not.toHaveBeenCalled();
  });

  it('falls back to agent-output.md when readEventLog rejects (unreadable file)', async () => {
    // readEventLog returns [] on any error (already tested in event-log.test.ts)
    // — simulate the error recovery behavior
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce([]);
    vi.mocked(secureFs.readFile).mockResolvedValueOnce('Fallback agent output' as any);

    await service.resumeFeature('/test/project', 'feature-1');

    expect(mockExecuteFeature).toHaveBeenCalledWith(
      '/test/project',
      'feature-1',
      false,
      false,
      undefined,
      expect.objectContaining({
        continuationPrompt: expect.stringContaining('Fallback agent output'),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Torn-tail events.jsonl → resumes successfully (readEventLog is tolerant)
  // -------------------------------------------------------------------------

  it('resumes successfully when events.jsonl has a torn tail (tolerant read)', async () => {
    // readEventLog already skips torn lines and returns valid events.
    // Here we verify the recovery path works end-to-end when some events are valid.
    const partialEvents: NormalizedEvent[] = [
      {
        v: 1,
        id: '0001',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'agent_message',
        provider: 'claude',
        text: 'Partial run message.',
      },
    ];
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce(partialEvents);
    vi.mocked(eventRenderer.renderEventsToContext).mockReturnValueOnce('Partial run message.');

    await service.resumeFeature('/test/project', 'feature-1');

    // Should resume using the partial events (not throw)
    expect(mockExecuteFeature).toHaveBeenCalledWith(
      '/test/project',
      'feature-1',
      false,
      false,
      undefined,
      expect.objectContaining({
        continuationPrompt: expect.stringContaining('Partial run message.'),
        _calledInternally: true,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: No context (agent-output.md missing) → fresh execution (existing behavior)
  // -------------------------------------------------------------------------

  it('starts fresh when no context exists (contextExists returns false)', async () => {
    // agent-output.md does not exist
    vi.mocked(secureFs.access).mockRejectedValueOnce(new Error('ENOENT'));

    await service.resumeFeature('/test/project', 'feature-1');

    // Neither events nor agent-output.md path
    expect(mockExecuteFeature).toHaveBeenCalledWith(
      '/test/project',
      'feature-1',
      false,
      false,
      undefined,
      expect.objectContaining({
        _calledInternally: true,
      })
    );
    // No continuationPrompt — fresh start
    const opts = mockExecuteFeature.mock.calls[0][5] as { continuationPrompt?: string };
    expect(opts.continuationPrompt).toBeUndefined();

    // readEventLog must NOT have been called (we only call it when hasContext is true)
    expect(eventLog.readEventLog).not.toHaveBeenCalled();
    expect(eventRenderer.renderEventsToContext).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Events with markers — rendered context contains verbatim sentinel text
  // -------------------------------------------------------------------------

  it('rendered context preserves phase_complete sentinel verbatim', async () => {
    const events: NormalizedEvent[] = [
      {
        v: 1,
        id: '0001',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'task_marker',
        provider: 'claude',
        marker: { type: 'phase_complete', phase: 3 },
      },
    ];
    vi.mocked(eventLog.readEventLog).mockResolvedValueOnce(events);

    // Use real renderer
    const { renderEventsToContext: realRenderer } = await vi.importActual<
      typeof import('@/events/event-renderer.js')
    >('@/events/event-renderer.js');
    vi.mocked(eventRenderer.renderEventsToContext).mockImplementationOnce(realRenderer);

    await service.resumeFeature('/test/project', 'feature-1');

    const prompt = mockExecuteFeature.mock.calls[0][5].continuationPrompt as string;
    expect(prompt).toContain('[PHASE_COMPLETE] Phase 3');
  });
});
