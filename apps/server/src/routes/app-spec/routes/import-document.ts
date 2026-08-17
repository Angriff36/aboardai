/**
 * POST /import-document — break an existing document into board tasks (features).
 *
 * Body: {
 *   projectPath: string;          // required
 *   documentText?: string;        // pasted document content (preferred — no path concerns)
 *   documentPath?: string;        // OR a file path to read (respects ALLOWED_ROOT_DIRECTORY)
 *   maxFeatures?: number;         // soft cap on extracted tasks
 * }
 * At least one of documentText / documentPath must be provided.
 */

import type { Request, Response } from 'express';
import type { EventEmitter } from '../../../lib/events.js';
import { createLogger } from '@aboardai/utils';
import * as secureFs from '../../../lib/secure-fs.js';
import {
  getSpecRegenerationStatus,
  setRunningState,
  logAuthStatus,
  logError,
  getErrorMessage,
} from '../common.js';
import { importFeaturesFromDocument } from '../import-from-document.js';
import type { SettingsService } from '../../../services/settings-service.js';

const logger = createLogger('DocumentImport');

export interface ImportDocumentBody {
  projectPath?: string;
  documentText?: string;
  documentPath?: string;
  maxFeatures?: number;
}

export type DocumentReader = (path: string) => Promise<string>;

const defaultReader: DocumentReader = async (path) =>
  (await secureFs.readFile(path, 'utf-8')) as string;

/**
 * Resolve the document content from the request body. Prefers inline `documentText`;
 * falls back to reading `documentPath` from disk. Pure aside from the injected reader,
 * which makes it unit-testable.
 *
 * @throws Error with a user-facing message when the input is invalid or unreadable.
 */
export async function resolveDocumentContent(
  body: ImportDocumentBody,
  readFile: DocumentReader = defaultReader
): Promise<string> {
  if (typeof body.documentText === 'string' && body.documentText.trim().length > 0) {
    return body.documentText;
  }

  if (typeof body.documentPath === 'string' && body.documentPath.trim().length > 0) {
    try {
      const content = await readFile(body.documentPath);
      if (!content.trim()) {
        throw new Error(`Document at "${body.documentPath}" is empty.`);
      }
      return content;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read document at "${body.documentPath}": ${reason}`);
    }
  }

  throw new Error('Provide either documentText or documentPath to import.');
}

export function createImportDocumentHandler(
  events: EventEmitter,
  settingsService?: SettingsService
) {
  return async (req: Request, res: Response): Promise<void> => {
    logger.info('========== /import-document endpoint called ==========');

    try {
      const body = (req.body ?? {}) as ImportDocumentBody;
      const { projectPath, maxFeatures } = body;

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath required' });
        return;
      }

      let documentContent: string;
      try {
        documentContent = await resolveDocumentContent(body);
      } catch (resolveErr) {
        res.status(400).json({ success: false, error: getErrorMessage(resolveErr) });
        return;
      }

      const { isRunning } = getSpecRegenerationStatus(projectPath);
      if (isRunning) {
        res.json({ success: false, error: 'Generation already running for this project' });
        return;
      }

      logAuthStatus('Before starting document import');

      const abortController = new AbortController();
      setRunningState(projectPath, true, abortController, 'document_import');
      logger.info('Starting background document import task...');

      importFeaturesFromDocument(
        projectPath,
        documentContent,
        { maxTasks: maxFeatures },
        events,
        abortController,
        settingsService
      )
        .catch((error) => {
          logError(error, 'Document import failed with error');
          events.emit('spec-regeneration:event', {
            type: 'spec_regeneration_error',
            error: getErrorMessage(error),
            projectPath,
          });
        })
        .finally(() => {
          logger.info('Document import task finished (success or error)');
          setRunningState(projectPath, false, null);
        });

      res.json({ success: true });
    } catch (error) {
      logError(error, 'Import document route handler failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
