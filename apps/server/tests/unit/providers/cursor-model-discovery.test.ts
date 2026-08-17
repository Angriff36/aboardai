import { describe, it, expect } from 'vitest';
import {
  parseCursorListModelsOutput,
  cursorSlugToModelDefinition,
  buildCursorListModelsArgs,
} from '../../../src/providers/cursor-model-discovery.js';

describe('cursor-model-discovery', () => {
  describe('buildCursorListModelsArgs', () => {
    it('uses agent --list-models for cursor IDE binary', () => {
      expect(buildCursorListModelsArgs('/usr/bin/cursor')).toEqual(['agent', '--list-models']);
    });

    it('uses --list-models only for cursor-agent binary', () => {
      expect(buildCursorListModelsArgs('/usr/bin/cursor-agent')).toEqual(['--list-models']);
    });
  });

  describe('parseCursorListModelsOutput', () => {
    it('parses one slug per line', () => {
      const output = `auto
composer-2.5-fast
claude-opus-4-8-thinking-high`;

      expect(parseCursorListModelsOutput(output)).toEqual([
        'auto',
        'composer-2.5-fast',
        'claude-opus-4-8-thinking-high',
      ]);
    });

    it('parses slug with parenthetical label', () => {
      const output = `composer-2.5-fast (Composer 2.5 Fast)
claude-sonnet-4-6 (current)`;

      expect(parseCursorListModelsOutput(output)).toEqual([
        'composer-2.5-fast',
        'claude-sonnet-4-6',
      ]);
    });

    it('parses tab-separated slug and label', () => {
      const output = 'gpt-5.3-codex\tGPT 5.3 Codex';
      expect(parseCursorListModelsOutput(output)).toEqual(['gpt-5.3-codex']);
    });

    it('parses dash-separated slug and label', () => {
      const output = 'claude-haiku-4-5 - Claude Haiku 4.5';
      expect(parseCursorListModelsOutput(output)).toEqual(['claude-haiku-4-5']);
    });

    it('parses JSON array of strings', () => {
      const output = JSON.stringify(['auto', 'composer-2.5-fast']);
      expect(parseCursorListModelsOutput(output)).toEqual(['auto', 'composer-2.5-fast']);
    });

    it('parses JSON array of objects with id field', () => {
      const output = JSON.stringify([{ id: 'auto', name: 'Auto' }, { model: 'composer-2.5-fast' }]);
      expect(parseCursorListModelsOutput(output)).toEqual(['auto', 'composer-2.5-fast']);
    });

    it('strips ANSI color codes', () => {
      const output = '\x1b[32mauto\x1b[0m\n\x1b[1mcomposer-2.5-fast\x1b[0m';
      expect(parseCursorListModelsOutput(output)).toEqual(['auto', 'composer-2.5-fast']);
    });

    it('skips header lines and deduplicates', () => {
      const output = `Available models
auto
auto
composer-2.5-fast`;

      expect(parseCursorListModelsOutput(output)).toEqual(['auto', 'composer-2.5-fast']);
    });

    it('returns empty array for empty output', () => {
      expect(parseCursorListModelsOutput('')).toEqual([]);
      expect(parseCursorListModelsOutput('   \n  ')).toEqual([]);
    });
  });

  describe('cursorSlugToModelDefinition', () => {
    it('prefixes bare slug with cursor-', () => {
      const model = cursorSlugToModelDefinition('composer-2.5-fast');
      expect(model.id).toBe('cursor-composer-2.5-fast');
      expect(model.modelString).toBe('composer-2.5-fast');
      expect(model.provider).toBe('cursor');
    });

    it('does not double-prefix cursor- slugs', () => {
      const model = cursorSlugToModelDefinition('cursor-auto');
      expect(model.id).toBe('cursor-auto');
      expect(model.default).toBe(true);
    });

    it('detects thinking models from slug', () => {
      const model = cursorSlugToModelDefinition('claude-opus-4-8-thinking-high');
      expect(model.id).toBe('cursor-claude-opus-4-8-thinking-high');
      expect(model.description).toContain('claude-opus-4-8-thinking-high');
    });
  });
});
