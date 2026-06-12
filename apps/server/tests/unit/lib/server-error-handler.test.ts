/**
 * Tests for apps/server/src/lib/error-handler.ts patterns
 *
 * Specifically verifies the Codex-specific error signals added in Task 8.2:
 * - 'stream disconnected' → NETWORK
 * - 'connection reset' → NETWORK
 * - 'model_not_found' → MODEL_NOT_SUPPORTED
 *
 * Existing patterns (rate_limit, unauthorized, stream ended, socket hang up)
 * are verified to still pass so classifyError stays backward-compatible.
 */

import { describe, it, expect } from 'vitest';
import { classifyError, ErrorType } from '../../../src/lib/error-handler.js';

describe('server error-handler.ts — Codex-specific patterns (Task 8.2)', () => {
  // -------------------------------------------------------------------------
  // Patterns that were ALREADY present (regression guard)
  // -------------------------------------------------------------------------

  it('rate_limit string → RATE_LIMIT', () => {
    const result = classifyError(new Error('rate_limit exceeded, please wait'));
    expect(result.type).toBe(ErrorType.RATE_LIMIT);
    expect(result.retryable).toBe(true);
  });

  it('unauthorized string → AUTHENTICATION', () => {
    const result = classifyError(new Error('stream error: last status: 401 Unauthorized'));
    expect(result.type).toBe(ErrorType.AUTHENTICATION);
    expect(result.retryable).toBe(false);
  });

  it('stream ended string → NETWORK (was already covered by /connection/i fallback)', () => {
    // "stream ended" does not match the old network patterns but should now
    // be explicitly matched — verify it classifies as NETWORK.
    const result = classifyError(new Error('stream ended unexpectedly'));
    expect(result.type).toBe(ErrorType.NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('socket hang up string → NETWORK', () => {
    const result = classifyError(new Error('socket hang up'));
    expect(result.type).toBe(ErrorType.NETWORK);
    expect(result.retryable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Genuinely NEW patterns added in Task 8.2
  // -------------------------------------------------------------------------

  it('stream disconnected → NETWORK (NEW)', () => {
    const result = classifyError(new Error('stream disconnected before turn completed'));
    expect(result.type).toBe(ErrorType.NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('connection reset → NETWORK (NEW — more explicit pattern)', () => {
    const result = classifyError(new Error('connection reset by peer'));
    expect(result.type).toBe(ErrorType.NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('model_not_found → MODEL_NOT_SUPPORTED (NEW)', () => {
    const result = classifyError(new Error('model_not_found: gpt-5.3-codex'));
    expect(result.type).toBe(ErrorType.MODEL_NOT_SUPPORTED);
    expect(result.retryable).toBe(false);
  });

  it('model does not exist → MODEL_NOT_SUPPORTED (NEW explicit form)', () => {
    const result = classifyError(new Error('The model gpt-5.3-codex does not exist'));
    expect(result.type).toBe(ErrorType.MODEL_NOT_SUPPORTED);
    expect(result.retryable).toBe(false);
  });

  it('do not have access model → MODEL_NOT_SUPPORTED (NEW — subscription gate)', () => {
    const result = classifyError(
      new Error('You do not have access to model gpt-5.3-codex — requires ChatGPT Pro')
    );
    expect(result.type).toBe(ErrorType.MODEL_NOT_SUPPORTED);
    expect(result.retryable).toBe(false);
  });
});
