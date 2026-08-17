/**
 * Cursor CLI model discovery via `cursor-agent --list-models`
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execInWsl } from '@aboardai/platform';
import { CURSOR_MODEL_MAP, type CursorModelId } from '@aboardai/types';
import type { ModelDefinition } from './types.js';

const execFileAsync = promisify(execFile);

/** Cache duration for dynamic model fetching (5 minutes) */
export const CURSOR_MODEL_CACHE_DURATION_MS = 5 * 60 * 1000;

export interface CursorCliContext {
  cliPath: string;
  useWsl: boolean;
  wslCliPath?: string | null;
  wslDistribution?: string;
}

/** Build CLI args for listing models (handles cursor IDE vs cursor-agent binary). */
export function buildCursorListModelsArgs(cliPath: string): string[] {
  const args: string[] = [];
  if (!cliPath.includes('cursor-agent')) {
    args.push('agent');
  }
  args.push('--list-models');
  return args;
}

/** Strip ANSI escape codes from CLI output. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse `cursor-agent --list-models` output into bare model slugs.
 * Supports one slug per line and optional "slug (label)" formatting.
 */
export function parseCursorListModelsOutput(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (typeof entry === 'string') return entry.trim();
            if (entry && typeof entry === 'object') {
              const record = entry as Record<string, unknown>;
              if (typeof record.id === 'string') return record.id.trim();
              if (typeof record.model === 'string') return record.model.trim();
              if (typeof record.name === 'string') return record.name.trim();
            }
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to line-based parsing
    }
  }

  const slugs: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of trimmed.split('\n')) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;
    if (/^(usage|available|model|name|---)/i.test(line)) continue;

    let slug = line;
    const parenIdx = line.indexOf('(');
    if (parenIdx > 0) {
      slug = line.slice(0, parenIdx).trim();
    } else if (line.includes('\t')) {
      slug = line.split('\t')[0]?.trim() ?? line;
    } else if (line.includes(' - ')) {
      slug = line.split(' - ')[0]?.trim() ?? line;
    }

    slug = slug.replace(/\s+\(current\)$/i, '').replace(/\s+\(default\)$/i, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }

  return slugs;
}

function formatCursorSlugLabel(slug: string): string {
  const staticConfig = CURSOR_MODEL_MAP[`cursor-${slug}` as CursorModelId];
  if (staticConfig) return staticConfig.label;

  return slug
    .split('-')
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/(\d)\s+(\d)/g, '$1.$2');
}

/** Convert a bare Cursor CLI slug to a ModelDefinition with canonical cursor- prefix. */
export function cursorSlugToModelDefinition(slug: string): ModelDefinition {
  const bareSlug = slug.startsWith('cursor-') ? slug.slice('cursor-'.length) : slug;
  const canonicalId = `cursor-${bareSlug}`;
  const staticConfig = CURSOR_MODEL_MAP[canonicalId as CursorModelId];
  const hasThinking =
    staticConfig?.hasThinking ?? (bareSlug.includes('-thinking') || bareSlug.endsWith('-high'));

  return {
    id: canonicalId,
    name: staticConfig?.label ?? formatCursorSlugLabel(bareSlug),
    modelString: bareSlug,
    provider: 'cursor',
    description: staticConfig?.description ?? `Cursor model: ${bareSlug}`,
    supportsTools: true,
    supportsVision: staticConfig?.supportsVision ?? false,
    default: bareSlug === 'auto',
  };
}

/** Static fallback models from CURSOR_MODEL_MAP when CLI discovery is unavailable. */
export function getStaticCursorModelDefinitions(): ModelDefinition[] {
  return Object.entries(CURSOR_MODEL_MAP).map(([id, config]) => ({
    id,
    name: config.label,
    modelString: id.startsWith('cursor-') ? id.slice('cursor-'.length) : id,
    provider: 'cursor',
    description: config.description,
    supportsTools: true,
    supportsVision: config.supportsVision,
    default: id === 'cursor-auto',
  }));
}

/** Fetch models from cursor-agent --list-models. */
export async function fetchCursorModelsFromCli(ctx: CursorCliContext): Promise<ModelDefinition[]> {
  const listArgs = buildCursorListModelsArgs(ctx.cliPath);
  let stdout = '';

  try {
    if (ctx.useWsl && ctx.wslCliPath) {
      const wslArgs = ctx.wslDistribution
        ? ['-d', ctx.wslDistribution, ctx.wslCliPath, ...listArgs]
        : [ctx.wslCliPath, ...listArgs];
      stdout =
        execInWsl(wslArgs.join(' '), {
          timeout: 30000,
          distribution: ctx.wslDistribution,
        }) ?? '';
    } else {
      const result = await execFileAsync(ctx.cliPath, listArgs, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
        shell: process.platform === 'win32' && ctx.cliPath.endsWith('.cmd'),
      });
      stdout = result.stdout;
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    stdout = err.stdout || err.stderr || '';
    if (!stdout.trim()) {
      throw error;
    }
  }

  const slugs = parseCursorListModelsOutput(stdout);
  if (slugs.length === 0) {
    return [];
  }

  return slugs.map(cursorSlugToModelDefinition);
}
