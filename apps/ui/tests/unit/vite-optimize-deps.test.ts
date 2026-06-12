/**
 * Guard test: every bare npm specifier imported in apps/ui/src must be present
 * in vite.config.mts's optimizeDeps.include list.
 *
 * Why this matters
 * ----------------
 * vite.config.mts uses `optimizeDeps.noDiscovery: true`, which means Vite will
 * ONLY pre-bundle the packages listed in `include` — it never auto-discovers new
 * ones at runtime. Any package that is NOT listed will be served as a raw
 * node_modules ESM file. For most packages that is harmless, but for any package
 * that relies on instanceof checks or shared singleton state (e.g. @codemirror/state,
 * react) it can silently create a second copy and trigger cryptic runtime errors:
 *
 *   "Unrecognized extension value in extension set ([object Object]).
 *    This sometimes happens because multiple instances of @codemirror/state are loaded."
 *
 * This test caught the @codemirror/* family missing from the include list (fix:
 * pre-bundle @codemirror family + import-coverage guard test).  It will fail if
 * someone adds a new import without updating optimizeDeps.include.
 *
 * EXCEPTIONS list
 * ---------------
 * Some specifiers are intentionally excluded from optimizeDeps.include:
 *
 *  - @aboardai/* packages: internal monorepo packages, not node_modules entries
 *  - Node built-ins / electron: external at build time, never pre-bundled
 *  - use-sync-external-store/shim, use-sync-external-store/shim/with-selector:
 *      these subpaths are in `include` but the bare `use-sync-external-store`
 *      root is also there; the scanner finds them all as separate entries
 *  - react/jsx-runtime, react/jsx-dev-runtime: subpaths included, root `react`
 *      covers the singleton concern; these are already in `include`
 *
 * If you add a new dependency that Vite should NOT pre-bundle (e.g. a pure-ESM
 * package with no CJS interop needs), add it to EXCEPTIONS below with a comment
 * explaining why.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// EXCEPTIONS: specifiers that are legitimately absent from optimizeDeps.include
// ---------------------------------------------------------------------------
const EXCEPTIONS = new Set<string>([
  // --- Internal monorepo packages (not in node_modules as pre-bundleable entries) ---
  '@aboardai/dependency-resolver',
  '@aboardai/model-resolver',
  '@aboardai/platform', // also in optimizeDeps.exclude
  '@aboardai/prompts',
  '@aboardai/spec-parser',
  '@aboardai/types',
  '@aboardai/utils/debounce',
  '@aboardai/utils/error-handler',
  '@aboardai/utils/logger',

  // --- Node.js built-ins and Electron — always external, never pre-bundled ---
  'child_process',
  'crypto',
  'electron',
  'events',
  'fs',
  'http',
  'net',
  'os',
  'path',
  'readline',
  'stream',
  'util',

  // --- False positives from the import regex scanner ---
  // These appear as import strings in source files but are NOT real package specifiers.
  // They are template literal expressions that happen to match the import pattern,
  // or multi-word strings embedded in dynamic constructs that our regex catches.
  '${conflictInfo.previousBranch}', // template literal in a string — not a real import
  '${conflictInfo.sourceBranch}', // template literal in a string — not a real import
  'Open in Terminal', // UI label string misidentified as import
  'bleeding', // partial word from a multi-line string
  'couldn', // partial word from a multi-line string (couldn't)
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkSync(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSync(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract all bare npm specifiers from static and dynamic imports in the given
 * source files. A "bare specifier" is one that does NOT start with `.`, `/`, or
 * `@/` (the local alias).  CSS/SCSS imports are also excluded.
 *
 * Subpath imports (e.g. `react-dom/client`, `zustand/middleware`) are preserved
 * as-is because Vite needs the exact subpath in `include` for some packages.
 */
export function extractBareImports(files: string[]): Set<string> {
  const importRe = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  const specifiers = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      const s = m[1];
      if (s.startsWith('.') || s.startsWith('/') || s.startsWith('@/')) continue;
      if (s.endsWith('.css') || s.endsWith('.scss') || s.endsWith('.less')) continue;
      specifiers.add(s);
    }
  }

  return specifiers;
}

/**
 * Parse the optimizeDeps.include array out of vite.config.mts using a simple
 * character-by-character scanner. Returns a Set of all string entries.
 *
 * We use scanning rather than dynamic import because:
 * 1. vite.config.mts uses top-level `require()` calls (getBuildHash) that fail in vitest
 * 2. The config exports a factory function that needs Vite's `defineConfig` context
 * 3. The scanner correctly handles brackets inside comments and strings
 *
 * Scanner state machine:
 * - Skips `// line comments` (which may contain `[` or `]` characters)
 * - Skips single-quoted and double-quoted string literals when walking brackets
 * - Correctly finds the matching `]` for the `include: [` opening bracket
 */
export function parseOptimizeDepsInclude(configPath: string): Set<string> {
  const content = fs.readFileSync(configPath, 'utf-8');

  // Find the `include: [` block inside `optimizeDeps`
  const optimizeDepsIdx = content.indexOf('optimizeDeps:');
  if (optimizeDepsIdx === -1) throw new Error('Could not find optimizeDeps: in vite.config.mts');

  const includeIdx = content.indexOf('include: [', optimizeDepsIdx);
  if (includeIdx === -1) throw new Error('Could not find include: [ in optimizeDeps');

  // Walk forward from `include: [` to find the matching `]`,
  // properly skipping // line comments and quoted strings.
  const startBracket = content.indexOf('[', includeIdx);
  let depth = 0;
  let endBracket = -1;
  let i = startBracket;
  while (i < content.length) {
    const ch = content[i];

    // Skip // line comments — they may contain [ or ] (e.g. // ([object Object]))
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }

    // Skip single-quoted string literals
    if (ch === "'") {
      i++; // skip opening quote
      while (i < content.length && content[i] !== "'") {
        if (content[i] === '\\') i++; // skip escape
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    // Skip double-quoted string literals
    if (ch === '"') {
      i++; // skip opening quote
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') i++; // skip escape
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        endBracket = i;
        break;
      }
    }
    i++;
  }
  if (endBracket === -1) throw new Error('Could not find closing ] for include array');

  const arrayText = content.slice(startBracket + 1, endBracket);

  // Extract string literals — only single or double quoted, not template literals.
  // Use a simple scan to avoid regex confusion with nested quotes in comments.
  const entries = new Set<string>();
  let j = 0;
  while (j < arrayText.length) {
    const c = arrayText[j];
    // Skip line comments
    if (c === '/' && arrayText[j + 1] === '/') {
      while (j < arrayText.length && arrayText[j] !== '\n') j++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      j++; // skip opening quote
      let str = '';
      while (j < arrayText.length && arrayText[j] !== quote) {
        if (arrayText[j] === '\\') j++; // skip escape
        str += arrayText[j];
        j++;
      }
      j++; // skip closing quote
      if (str.length > 0) entries.add(str);
      continue;
    }
    j++;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('vite optimizeDeps.include coverage', () => {
  const uiRoot = path.resolve(__dirname, '../../');
  const srcDir = path.join(uiRoot, 'src');
  const configPath = path.join(uiRoot, 'vite.config.mts');

  it('every bare import in src/ is present in optimizeDeps.include (or EXCEPTIONS)', () => {
    const files = walkSync(srcDir, ['.ts', '.tsx']);
    expect(files.length).toBeGreaterThan(0); // sanity: we found source files

    const bareImports = extractBareImports(files);
    const includeSet = parseOptimizeDepsInclude(configPath);

    const missing: string[] = [];
    for (const specifier of bareImports) {
      if (EXCEPTIONS.has(specifier)) continue;
      if (includeSet.has(specifier)) continue;
      missing.push(specifier);
    }

    if (missing.length > 0) {
      // Provide actionable output
      const formatted = missing.map((s) => `  '${s}',`).join('\n');
      throw new Error(
        `The following bare imports are NOT in optimizeDeps.include.\n` +
          `Add them to the include list in apps/ui/vite.config.mts, or add them\n` +
          `to the EXCEPTIONS set in this test file with an explanatory comment.\n\n` +
          `Missing (${missing.length}):\n${formatted}`
      );
    }
  });

  it('parseOptimizeDepsInclude extracts a non-empty set from vite.config.mts', () => {
    const includeSet = parseOptimizeDepsInclude(configPath);
    // We know there are at least 50 entries after the codemirror fix
    expect(includeSet.size).toBeGreaterThan(50);
    // Spot-check a few known entries
    expect(includeSet.has('react')).toBe(true);
    expect(includeSet.has('@codemirror/state')).toBe(true);
    expect(includeSet.has('@codemirror/view')).toBe(true);
    expect(includeSet.has('@xterm/xterm')).toBe(true);
  });

  it('EXCEPTIONS list does not contain entries that are also in optimizeDeps.include', () => {
    // An entry in both places is just dead weight in EXCEPTIONS — flag it so the
    // list stays clean.
    const includeSet = parseOptimizeDepsInclude(configPath);
    const redundant: string[] = [];
    for (const exc of EXCEPTIONS) {
      if (includeSet.has(exc)) redundant.push(exc);
    }
    if (redundant.length > 0) {
      throw new Error(
        `These EXCEPTIONS entries are also in optimizeDeps.include — remove them\n` +
          `from the EXCEPTIONS set in this test file:\n` +
          redundant.map((s) => `  '${s}'`).join('\n')
      );
    }
  });
});
