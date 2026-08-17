/**
 * Import an existing document (audit register, implementation plan, PRD, checklist,
 * roadmap, design notes) and break it into board tasks (features).
 *
 * This is the general counterpart to `generate-features-from-spec.ts`:
 *   - generate-features-from-spec INVENTS new features from `.aboardai/app_spec.txt`
 *   - import-from-document EXTRACTS the work items a user-provided document already
 *     describes and normalizes its ordering signals into `dependencies`.
 *
 * It deliberately reuses the same model resolution, structured-output handling, JSON
 * extraction, and `parseAndCreateFeatures` persistence as the spec flow, and emits on
 * the same `spec-regeneration:event` channel so all existing progress / notification /
 * board-invalidation plumbing applies with no extra wiring.
 *
 * Model is configurable via phaseModels.featureGenerationModel in settings.
 */

import type { EventEmitter } from '../../lib/events.js';
import { createLogger } from '@aboardai/utils';
import { DEFAULT_PHASE_MODELS, supportsStructuredOutput, isCodexModel } from '@aboardai/types';
import { DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT } from '@aboardai/prompts';
import { resolvePhaseModel } from '@aboardai/model-resolver';
import { streamingQuery } from '../../providers/simple-query-service.js';
import { parseAndCreateFeatures } from './parse-and-create-features.js';
import { extractJsonWithArray } from '../../lib/json-extractor.js';
import type { SettingsService } from '../../services/settings-service.js';
import {
  getAutoLoadClaudeMdSetting,
  getPhaseModelWithOverrides,
} from '../../lib/settings-helpers.js';
import { FeatureLoader } from '../../services/feature-loader.js';
import type { Feature } from '@aboardai/types';

const logger = createLogger('DocumentImport');

/** Default cap on how many tasks to extract from a single document. */
export const DEFAULT_MAX_IMPORT_TASKS = 50;

/** JSON schema for the extracted-tasks output (Claude/Codex structured output). */
const importOutputSchema = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique task identifier (kebab-case)' },
          category: { type: 'string', description: 'Theme / section from the document' },
          title: { type: 'string', description: 'Short, specific title' },
          description: { type: 'string', description: 'What to do and the target end-state' },
          priority: { type: 'number', description: 'Priority level: 1 (highest) to 5 (lowest)' },
          complexity: {
            type: 'string',
            enum: ['simple', 'moderate', 'complex'],
            description: 'Implementation complexity',
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'ids of other extracted tasks that must be done first',
          },
        },
        required: ['id', 'title', 'description'],
      },
    },
  },
  required: ['features'],
} as const;

interface ImportExtractionResult {
  features: Array<{
    id: string;
    category?: string;
    title: string;
    description: string;
    priority?: number;
    complexity?: 'simple' | 'moderate' | 'complex';
    dependencies?: string[];
  }>;
}

/**
 * Build the dedup context block listing existing board features so the model does not
 * re-emit tasks that are already present. Returns '' when there are no existing features.
 *
 * Exported for testing.
 */
export function buildExistingFeaturesContext(
  existingFeatures: Pick<Feature, 'id' | 'title' | 'description'>[]
): string {
  if (existingFeatures.length === 0) return '';

  const featuresList = existingFeatures
    .map(
      (f) => `- "${f.title}" (ID: ${f.id}): ${f.description?.substring(0, 100) || 'No description'}`
    )
    .join('\n');

  return `

## EXISTING FEATURES (DO NOT RE-IMPORT THESE)

The board already contains these ${existingFeatures.length} features. Do NOT emit tasks that duplicate or overlap with them, and do not reuse their ids:

${featuresList}
`;
}

/**
 * Build the full import prompt sent to the model. Pure function — no IO — so it can be
 * unit tested directly.
 *
 * @param documentContent  Raw text of the document to break down.
 * @param existingFeatures Current board features (for dedup); pass [] for none.
 * @param importInstruction The extraction instruction (defaults to the shipped prompt).
 * @param maxTasks         Soft cap on the number of tasks to extract.
 */
export function buildImportPrompt(
  documentContent: string,
  existingFeatures: Pick<Feature, 'id' | 'title' | 'description'>[],
  importInstruction: string = DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT,
  maxTasks: number = DEFAULT_MAX_IMPORT_TASKS
): string {
  const existingFeaturesContext = buildExistingFeaturesContext(existingFeatures);

  return `Break the following document into implementable board tasks.

===== BEGIN DOCUMENT =====
${documentContent}
===== END DOCUMENT =====
${existingFeaturesContext}
${importInstruction}

Extract at most ${maxTasks} tasks. If the document describes fewer discrete work items than that, extract only the ones that genuinely exist — do not pad the list.`;
}

/**
 * Append explicit JSON-only instructions for models that do not support structured
 * output. Pure function — exported for testing.
 */
export function appendPlainJsonInstructions(prompt: string): string {
  return `${prompt}

CRITICAL INSTRUCTIONS:
1. DO NOT write any files. Return the JSON in your response only.
2. Respond with ONLY a JSON object - no explanations, no markdown, just raw JSON.
3. The JSON must have this exact structure:
{
  "features": [
    {
      "id": "task-id",
      "category": "Theme/Section",
      "title": "Task Title",
      "description": "What to do and the target end-state",
      "priority": 2,
      "complexity": "simple|moderate|complex",
      "dependencies": ["other-task-id"]
    }
  ]
}

4. ids must be unique, lowercase, kebab-case.
5. priority ranges from 1 (highest) to 5 (lowest).
6. dependencies is an array of ids from this same list (can be empty).

Your entire response should be valid JSON starting with { and ending with }. No text before or after.`;
}

export interface ImportFromDocumentOptions {
  /** Soft cap on extracted tasks. Defaults to DEFAULT_MAX_IMPORT_TASKS. */
  maxTasks?: number;
}

/**
 * Run the full import: build prompt -> query model -> extract JSON -> create features.
 * Features are created in the `backlog` status (same as spec-driven generation), ready
 * for the user to edit or for auto-mode to pick up.
 */
export async function importFeaturesFromDocument(
  projectPath: string,
  documentContent: string,
  options: ImportFromDocumentOptions,
  events: EventEmitter,
  abortController: AbortController,
  settingsService?: SettingsService
): Promise<void> {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_IMPORT_TASKS;
  logger.info('========== importFeaturesFromDocument() started ==========');
  logger.info(`projectPath: ${projectPath}`);
  logger.info(`document length: ${documentContent.length} chars, maxTasks: ${maxTasks}`);

  if (!documentContent.trim()) {
    const errorMessage = 'Document is empty — nothing to import.';
    events.emit('spec-regeneration:event', {
      type: 'spec_regeneration_error',
      error: errorMessage,
      projectPath,
    });
    throw new Error(errorMessage);
  }

  // Load existing features so the model does not re-import what is already on the board.
  const featureLoader = new FeatureLoader();
  const existingFeatures = await featureLoader.getAll(projectPath);
  logger.info(`Found ${existingFeatures.length} existing features to exclude from import`);

  const prompt = buildImportPrompt(
    documentContent,
    existingFeatures,
    DEFAULT_IMPORT_FROM_DOCUMENT_PROMPT,
    maxTasks
  );

  events.emit('spec-regeneration:event', {
    type: 'spec_regeneration_progress',
    content: 'Reading document and extracting tasks...\n',
    projectPath,
  });

  const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
    projectPath,
    settingsService,
    '[DocumentImport]'
  );

  // Resolve model from the same phase setting used by feature generation.
  const {
    phaseModel: phaseModelEntry,
    provider,
    credentials,
  } = settingsService
    ? await getPhaseModelWithOverrides(
        'featureGenerationModel',
        settingsService,
        projectPath,
        '[DocumentImport]'
      )
    : {
        phaseModel: DEFAULT_PHASE_MODELS.featureGenerationModel,
        provider: undefined,
        credentials: undefined,
      };
  const { model, thinkingLevel, reasoningEffort } = resolvePhaseModel(phaseModelEntry);

  logger.info(
    `Using model: ${model} ${provider ? `via provider: ${provider.name}` : 'direct API'}`
  );

  const isCodex = isCodexModel(model);
  const effectiveReasoningEffort = isCodex ? 'xhigh' : reasoningEffort;

  const useStructuredOutput = supportsStructuredOutput(model);
  const finalPrompt = useStructuredOutput ? prompt : appendPlainJsonInstructions(prompt);

  const result = await streamingQuery({
    prompt: finalPrompt,
    model,
    cwd: projectPath,
    maxTurns: 250,
    allowedTools: ['Read', 'Glob', 'Grep'],
    abortController,
    thinkingLevel,
    reasoningEffort: effectiveReasoningEffort,
    readOnly: true,
    settingSources: autoLoadClaudeMd ? ['user', 'project', 'local'] : undefined,
    claudeCompatibleProvider: provider,
    credentials,
    outputFormat: useStructuredOutput
      ? { type: 'json_schema', schema: importOutputSchema }
      : undefined,
    onText: (text) => {
      events.emit('spec-regeneration:event', {
        type: 'spec_regeneration_progress',
        content: text,
        projectPath,
      });
    },
  });

  let contentForParsing: string;
  if (result.structured_output) {
    logger.info('✅ Received structured output from model');
    contentForParsing = JSON.stringify(result.structured_output);
  } else {
    const rawText = result.text;
    logger.info(`Import stream complete. Response length: ${rawText.length} chars`);
    const extracted = extractJsonWithArray<ImportExtractionResult>(rawText, 'features', { logger });
    if (extracted) {
      contentForParsing = JSON.stringify(extracted);
    } else {
      const errorMessage =
        'Failed to parse tasks from model response: No valid JSON with a "features" array found.';
      logger.error(`❌ ${errorMessage} Full response:\n${rawText}`);
      events.emit('spec-regeneration:event', {
        type: 'spec_regeneration_error',
        error: errorMessage,
        projectPath,
      });
      throw new Error(errorMessage);
    }
  }

  // Reuse the exact same persistence path as spec-driven feature generation. This emits
  // `spec_regeneration_complete` on success, which the UI already listens for to refresh
  // the board.
  await parseAndCreateFeatures(projectPath, contentForParsing, events, settingsService);

  logger.info('========== importFeaturesFromDocument() completed ==========');
}
