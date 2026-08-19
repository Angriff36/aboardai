import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPERVISOR_POLICY,
  SupervisorExhaustedError,
  type SupervisorStatusMessage,
  type ProviderMessage,
} from '@aboardai/types';

describe('supervisor-types.ts', () => {
  describe('DEFAULT_SUPERVISOR_POLICY', () => {
    it('should have correct stallTimeoutMs value', () => {
      expect(DEFAULT_SUPERVISOR_POLICY.stallTimeoutMs).toBe(300_000);
    });

    it('should have correct maxAttempts value', () => {
      expect(DEFAULT_SUPERVISOR_POLICY.maxAttempts).toBe(4);
    });

    it('should have correct baseDelayMs value', () => {
      expect(DEFAULT_SUPERVISOR_POLICY.baseDelayMs).toBe(2_000);
    });

    it('should have correct maxDelayMs value', () => {
      expect(DEFAULT_SUPERVISOR_POLICY.maxDelayMs).toBe(60_000);
    });
  });

  describe('SupervisorExhaustedError', () => {
    it('should be an instance of Error', () => {
      const error = new SupervisorExhaustedError('test message', 'test-classification', 3);
      expect(error).toBeInstanceOf(Error);
    });

    it('should have correct name', () => {
      const error = new SupervisorExhaustedError('test message', 'test-classification', 3);
      expect(error.name).toBe('SupervisorExhaustedError');
    });

    it('should carry classification field', () => {
      const error = new SupervisorExhaustedError('test message', 'rate_limit', 3);
      expect(error.classification).toBe('rate_limit');
    });

    it('should carry attempts field', () => {
      const error = new SupervisorExhaustedError('test message', 'test-classification', 5);
      expect(error.attempts).toBe(5);
    });

    it('should carry lastError field', () => {
      const originalError = new Error('original failure');
      const error = new SupervisorExhaustedError(
        'test message',
        'test-classification',
        3,
        originalError
      );
      expect(error.lastError).toBe(originalError);
    });

    it('should work without lastError parameter', () => {
      const error = new SupervisorExhaustedError('test message', 'test-classification', 2);
      expect(error.lastError).toBeUndefined();
    });
  });

  describe('SupervisorStatusMessage assignability to ProviderMessage', () => {
    it('should allow SupervisorStatusMessage as ProviderMessage', () => {
      const supervisorMsg: SupervisorStatusMessage = {
        type: 'supervisor_status',
        status: 'started',
      };

      // Type-level assertion: this should compile without error
      const providerMsg: ProviderMessage = supervisorMsg;
      expect(providerMsg.type).toBe('supervisor_status');
    });

    it('should allow SupervisorStatusMessage with all fields as ProviderMessage', () => {
      const supervisorMsg: SupervisorStatusMessage = {
        type: 'supervisor_status',
        status: 'reconnecting',
        detail: 'Stream timeout detected',
        attempt: 2,
        retryAfterMs: 5000,
      };

      const providerMsg: ProviderMessage = supervisorMsg;
      expect(providerMsg.type).toBe('supervisor_status');
    });

    it('should allow all valid supervisor status values', () => {
      const statuses: Array<SupervisorStatusMessage['status']> = [
        'started',
        'stalled',
        'reconnecting',
        'resumed',
        'rate_limited',
        'interrupted',
        'fatal',
      ];

      statuses.forEach((status) => {
        const msg: SupervisorStatusMessage = {
          type: 'supervisor_status',
          status,
        };
        const providerMsg: ProviderMessage = msg;
        expect(providerMsg.type).toBe('supervisor_status');
      });
    });
  });
});
