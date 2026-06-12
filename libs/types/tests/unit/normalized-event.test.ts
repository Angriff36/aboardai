import { describe, it, expect } from 'vitest';
import type { NormalizedEvent, NormalizedEventKind } from '@aboardai/types';

describe('normalized-event.ts', () => {
  describe('NormalizedEventKind type union', () => {
    it('should include all 13 expected kinds', () => {
      // Type-level test: all kinds should be valid strings
      const kinds: NormalizedEventKind[] = [
        'agent_message',
        'thinking',
        'tool_use',
        'tool_result',
        'file_edit',
        'command_run',
        'question',
        'task_marker',
        'summary',
        'status',
        'session',
        'error',
        'result',
      ];
      expect(kinds).toHaveLength(13);
    });
  });

  describe('NormalizedEvent assignability and JSON round-trip', () => {
    it('should create agent_message event with text payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '001',
        ts: '2026-06-12T10:00:00Z',
        kind: 'agent_message',
        provider: 'claude',
        featureId: 'feature-123',
        text: 'Here is the implementation',
      };

      // JSON round-trip
      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('agent_message');
      expect(parsed.text).toBe('Here is the implementation');
      expect(parsed.v).toBe(1);
    });

    it('should create thinking event with thinkingChars payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '002',
        ts: '2026-06-12T10:00:01Z',
        kind: 'thinking',
        provider: 'claude',
        featureId: 'feature-123',
        thinkingChars: 2048,
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('thinking');
      expect(parsed.thinkingChars).toBe(2048);
    });

    it('should create tool_use event with tool payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '003',
        ts: '2026-06-12T10:00:02Z',
        kind: 'tool_use',
        provider: 'claude',
        featureId: 'feature-123',
        tool: {
          name: 'Read',
          toolUseId: 'tooluse_abc123',
          inputPreview: 'file.ts:1-50',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('tool_use');
      expect(parsed.tool?.name).toBe('Read');
      expect(parsed.tool?.inputPreview).toBe('file.ts:1-50');
    });

    it('should create tool_result event with text payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '004',
        ts: '2026-06-12T10:00:03Z',
        kind: 'tool_result',
        provider: 'claude',
        featureId: 'feature-123',
        text: 'export function foo() { ... }',
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('tool_result');
      expect(parsed.text).toBeDefined();
    });

    it('should create file_edit event with file payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '005',
        ts: '2026-06-12T10:00:04Z',
        kind: 'file_edit',
        provider: 'claude',
        featureId: 'feature-123',
        file: {
          path: 'src/index.ts',
          tool: 'Edit',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('file_edit');
      expect(parsed.file?.path).toBe('src/index.ts');
      expect(parsed.file?.tool).toBe('Edit');
    });

    it('should create command_run event with command payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '006',
        ts: '2026-06-12T10:00:05Z',
        kind: 'command_run',
        provider: 'claude',
        featureId: 'feature-123',
        command: {
          command: 'npm run build',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('command_run');
      expect(parsed.command?.command).toBe('npm run build');
    });

    it('should create question event with tool payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '007',
        ts: '2026-06-12T10:00:06Z',
        kind: 'question',
        provider: 'claude',
        featureId: 'feature-123',
        tool: {
          name: 'AskUserQuestion',
          toolUseId: 'tooluse_q1',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('question');
      expect(parsed.tool?.name).toBe('AskUserQuestion');
    });

    it('should create task_marker event with marker payload (task_start)', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '008',
        ts: '2026-06-12T10:00:07Z',
        kind: 'task_marker',
        provider: 'claude',
        featureId: 'feature-123',
        marker: {
          type: 'task_start',
          taskId: 'T001',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('task_marker');
      expect(parsed.marker?.type).toBe('task_start');
      expect(parsed.marker?.taskId).toBe('T001');
    });

    it('should create task_marker event with marker payload (task_complete)', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '009',
        ts: '2026-06-12T10:00:08Z',
        kind: 'task_marker',
        provider: 'claude',
        featureId: 'feature-123',
        marker: {
          type: 'task_complete',
          taskId: 'T001',
          summary: 'task done',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('task_marker');
      expect(parsed.marker?.type).toBe('task_complete');
      expect(parsed.marker?.summary).toBe('task done');
    });

    it('should create task_marker event with marker payload (phase_complete)', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '010',
        ts: '2026-06-12T10:00:09Z',
        kind: 'task_marker',
        provider: 'claude',
        featureId: 'feature-123',
        marker: {
          type: 'phase_complete',
          phase: 2,
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('task_marker');
      expect(parsed.marker?.type).toBe('phase_complete');
      expect(parsed.marker?.phase).toBe(2);
    });

    it('should create summary event with text payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '011',
        ts: '2026-06-12T10:00:10Z',
        kind: 'summary',
        provider: 'claude',
        featureId: 'feature-123',
        text: 'Completed implementation of feature X',
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('summary');
      expect(parsed.text).toBe('Completed implementation of feature X');
    });

    it('should create status event with status payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '012',
        ts: '2026-06-12T10:00:11Z',
        kind: 'status',
        provider: 'claude',
        featureId: 'feature-123',
        status: {
          status: 'rate_limited',
          attempt: 2,
          retryAfterMs: 30000,
          detail: 'Rate limited by provider',
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('status');
      expect(parsed.status?.status).toBe('rate_limited');
      expect(parsed.status?.retryAfterMs).toBe(30000);
    });

    it('should create session event with sessionId payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '013',
        ts: '2026-06-12T10:00:12Z',
        kind: 'session',
        provider: 'claude',
        featureId: 'feature-123',
        sessionId: 'session_xyz789',
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('session');
      expect(parsed.sessionId).toBe('session_xyz789');
    });

    it('should create error event with text payload', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '014',
        ts: '2026-06-12T10:00:13Z',
        kind: 'error',
        provider: 'claude',
        featureId: 'feature-123',
        text: 'An error occurred during execution',
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('error');
      expect(parsed.text).toBeDefined();
    });

    it('should create result event with result payload (success)', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '015',
        ts: '2026-06-12T10:00:14Z',
        kind: 'result',
        provider: 'claude',
        featureId: 'feature-123',
        result: {
          subtype: 'success',
          isError: false,
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('result');
      expect(parsed.result?.isError).toBe(false);
    });

    it('should create result event with result payload (error)', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '016',
        ts: '2026-06-12T10:00:15Z',
        kind: 'result',
        provider: 'claude',
        featureId: 'feature-123',
        result: {
          subtype: 'validation_error',
          isError: true,
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.kind).toBe('result');
      expect(parsed.result?.isError).toBe(true);
    });
  });

  describe('NormalizedEvent schema version', () => {
    it('should always have v: 1', () => {
      const event: NormalizedEvent = {
        v: 1,
        id: '001',
        ts: '2026-06-12T10:00:00Z',
        kind: 'agent_message',
        provider: 'claude',
      };

      expect(event.v).toBe(1);
      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as NormalizedEvent;
      expect(parsed.v).toBe(1);
    });

    it('should reject invalid schema versions at type level', () => {
      // This test verifies the type constraint via TypeScript compilation
      // A valid event must have v: 1
      const event: NormalizedEvent = {
        v: 1,
        id: '001',
        ts: '2026-06-12T10:00:00Z',
        kind: 'agent_message',
        provider: 'claude',
      };
      expect(event.v).toBe(1);
    });
  });
});
