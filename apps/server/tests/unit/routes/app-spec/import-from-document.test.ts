import { describe, it, expect, vi } from 'vitest';
import {
  buildImportPrompt,
  buildExistingFeaturesContext,
  appendPlainJsonInstructions,
  DEFAULT_MAX_IMPORT_TASKS,
} from '@/routes/app-spec/import-from-document.js';
import { resolveDocumentContent } from '@/routes/app-spec/routes/import-document.js';
import { DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT } from '@aboardai/prompts';

describe('buildExistingFeaturesContext', () => {
  it('returns empty string when there are no existing features', () => {
    expect(buildExistingFeaturesContext([])).toBe('');
  });

  it('lists existing feature ids and titles and warns against re-importing', () => {
    const ctx = buildExistingFeaturesContext([
      { id: 'auth-login', title: 'Login', description: 'Email/password login' },
      { id: 'auth-logout', title: 'Logout', description: 'Sign the user out' },
    ]);
    expect(ctx).toContain('DO NOT RE-IMPORT');
    expect(ctx).toContain('auth-login');
    expect(ctx).toContain('Login');
    expect(ctx).toContain('auth-logout');
  });
});

describe('buildImportPrompt', () => {
  const doc =
    '# Implementation Plan\n\n## Phase 1\n- Build the parser\n\n## Phase 2\n- Wire the UI';

  it('wraps the document between explicit markers', () => {
    const prompt = buildImportPrompt(doc, []);
    expect(prompt).toContain('===== BEGIN DOCUMENT =====');
    expect(prompt).toContain('===== END DOCUMENT =====');
    expect(prompt).toContain('Build the parser');
    expect(prompt).toContain('Wire the UI');
  });

  it('includes the extraction instruction (dependency normalization)', () => {
    const prompt = buildImportPrompt(doc, []);
    expect(prompt).toContain(DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT);
    // The shipped instruction must teach dependency normalization for ordering.
    expect(DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT.toLowerCase()).toContain('dependencies');
  });

  it('honors the maxTasks cap in the prompt text', () => {
    expect(buildImportPrompt(doc, [], DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT, 7)).toContain(
      'at most 7 tasks'
    );
  });

  it('defaults the cap to DEFAULT_MAX_IMPORT_TASKS', () => {
    expect(buildImportPrompt(doc, [])).toContain(`at most ${DEFAULT_MAX_IMPORT_TASKS} tasks`);
  });

  it('embeds the existing-features dedup context when features are present', () => {
    const prompt = buildImportPrompt(doc, [
      { id: 'existing-one', title: 'Existing One', description: 'already on the board' },
    ]);
    expect(prompt).toContain('existing-one');
    expect(prompt).toContain('DO NOT RE-IMPORT');
  });

  it('omits the dedup context entirely when there are no existing features', () => {
    const prompt = buildImportPrompt(doc, []);
    expect(prompt).not.toContain('DO NOT RE-IMPORT');
  });
});

describe('appendPlainJsonInstructions', () => {
  it('adds JSON-only output instructions for non-structured-output models', () => {
    const out = appendPlainJsonInstructions('BASE');
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('"features"');
    expect(out).toContain('valid JSON');
  });
});

describe('resolveDocumentContent', () => {
  it('returns inline documentText when provided', async () => {
    const reader = vi.fn();
    const content = await resolveDocumentContent({ documentText: 'hello world' }, reader);
    expect(content).toBe('hello world');
    expect(reader).not.toHaveBeenCalled();
  });

  it('prefers documentText over documentPath when both are present', async () => {
    const reader = vi.fn().mockResolvedValue('from disk');
    const content = await resolveDocumentContent(
      { documentText: 'inline', documentPath: '/some/path.md' },
      reader
    );
    expect(content).toBe('inline');
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads documentPath via the injected reader when no text is given', async () => {
    const reader = vi.fn().mockResolvedValue('# Plan from file');
    const content = await resolveDocumentContent({ documentPath: '/plan.md' }, reader);
    expect(content).toBe('# Plan from file');
    expect(reader).toHaveBeenCalledWith('/plan.md');
  });

  it('throws when neither documentText nor documentPath is provided', async () => {
    await expect(resolveDocumentContent({})).rejects.toThrow(/documentText or documentPath/);
  });

  it('treats blank documentText as missing and requires a source', async () => {
    await expect(resolveDocumentContent({ documentText: '   ' })).rejects.toThrow(
      /documentText or documentPath/
    );
  });

  it('wraps reader failures in a user-facing message', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'));
    await expect(resolveDocumentContent({ documentPath: '/missing.md' }, reader)).rejects.toThrow(
      /Could not read document.*ENOENT/
    );
  });

  it('rejects an empty file read from documentPath', async () => {
    const reader = vi.fn().mockResolvedValue('   \n  ');
    await expect(resolveDocumentContent({ documentPath: '/empty.md' }, reader)).rejects.toThrow(
      /is empty/
    );
  });
});
