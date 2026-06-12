import { describe, it, expect } from 'vitest';
import {
  isAdaptiveThinkingModel,
  getThinkingLevelsForModel,
  normalizeThinkingLevelForModel,
  getDefaultThinkingLevel,
} from '@aboardai/types';

describe('settings.ts — adaptive thinking helpers', () => {
  // ---------------------------------------------------------------------------
  // isAdaptiveThinkingModel
  // ---------------------------------------------------------------------------

  describe('isAdaptiveThinkingModel', () => {
    it('recognizes claude-opus-4-8 (new default model)', () => {
      expect(isAdaptiveThinkingModel('claude-opus-4-8')).toBe(true);
    });

    it('recognizes date-pinned claude-opus-4-8 snapshots via substring', () => {
      expect(isAdaptiveThinkingModel('claude-opus-4-8-20260101')).toBe(true);
    });

    it('recognizes claude-opus-4-6 (previous Opus)', () => {
      expect(isAdaptiveThinkingModel('claude-opus-4-6')).toBe(true);
    });

    it("recognizes 'claude-opus' alias", () => {
      expect(isAdaptiveThinkingModel('claude-opus')).toBe(true);
    });

    it('does NOT recognize claude-sonnet-4-6 (supports both adaptive and extended thinking)', () => {
      // Sonnet 4.6 intentionally stays outside the adaptive-only list so that
      // manual thinking levels remain available in the UI.
      expect(isAdaptiveThinkingModel('claude-sonnet-4-6')).toBe(false);
    });

    it('does NOT recognize claude-haiku-4-5-20251001 (budget model only)', () => {
      expect(isAdaptiveThinkingModel('claude-haiku-4-5-20251001')).toBe(false);
    });

    it('does NOT recognize claude-sonnet-4-20250514', () => {
      expect(isAdaptiveThinkingModel('claude-sonnet-4-20250514')).toBe(false);
    });

    it('returns false for unknown models', () => {
      expect(isAdaptiveThinkingModel('gpt-5')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getThinkingLevelsForModel
  // ---------------------------------------------------------------------------

  describe('getThinkingLevelsForModel', () => {
    it('returns only [none, adaptive] for opus-4-8', () => {
      expect(getThinkingLevelsForModel('claude-opus-4-8')).toEqual(['none', 'adaptive']);
    });

    it('returns only [none, adaptive] for opus-4-6', () => {
      expect(getThinkingLevelsForModel('claude-opus-4-6')).toEqual(['none', 'adaptive']);
    });

    it('returns full range for sonnet-4-6 (adaptive + extended)', () => {
      const levels = getThinkingLevelsForModel('claude-sonnet-4-6');
      expect(levels).toContain('none');
      expect(levels).toContain('low');
      expect(levels).toContain('ultrathink');
      expect(levels).not.toContain('adaptive');
    });

    it('returns full range for haiku-4-5 (budget model)', () => {
      const levels = getThinkingLevelsForModel('claude-haiku-4-5-20251001');
      expect(levels).toContain('none');
      expect(levels).toContain('ultrathink');
    });
  });

  // ---------------------------------------------------------------------------
  // getDefaultThinkingLevel
  // ---------------------------------------------------------------------------

  describe('getDefaultThinkingLevel', () => {
    it("returns 'adaptive' for opus-4-8", () => {
      expect(getDefaultThinkingLevel('claude-opus-4-8')).toBe('adaptive');
    });

    it("returns 'adaptive' for opus-4-6", () => {
      expect(getDefaultThinkingLevel('claude-opus-4-6')).toBe('adaptive');
    });

    it("returns 'none' for sonnet-4-6", () => {
      expect(getDefaultThinkingLevel('claude-sonnet-4-6')).toBe('none');
    });

    it("returns 'none' for haiku-4-5", () => {
      expect(getDefaultThinkingLevel('claude-haiku-4-5-20251001')).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // normalizeThinkingLevelForModel
  // ---------------------------------------------------------------------------

  describe('normalizeThinkingLevelForModel', () => {
    it("preserves 'adaptive' for opus-4-8", () => {
      expect(normalizeThinkingLevelForModel('claude-opus-4-8', 'adaptive')).toBe('adaptive');
    });

    it("normalizes 'high' → 'none' for opus-4-8 (not in adaptive-only list)", () => {
      expect(normalizeThinkingLevelForModel('claude-opus-4-8', 'high')).toBe('none');
    });

    it("normalizes 'adaptive' → 'none' for sonnet-4-6 (not in extended-thinking list)", () => {
      // sonnet-4-6 available levels = [none, low, medium, high, ultrathink]
      expect(normalizeThinkingLevelForModel('claude-sonnet-4-6', 'adaptive')).toBe('none');
    });

    it("preserves 'high' for sonnet-4-6", () => {
      expect(normalizeThinkingLevelForModel('claude-sonnet-4-6', 'high')).toBe('high');
    });

    it("falls back to 'none' for undefined thinkingLevel", () => {
      expect(normalizeThinkingLevelForModel('claude-opus-4-8', undefined)).toBe('none');
    });
  });
});
