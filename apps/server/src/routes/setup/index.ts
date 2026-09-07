/**
 * Setup routes - HTTP API for CLI detection, API keys, and platform info
 */

import { Router } from 'express';
import { createClaudeStatusHandler } from './routes/claude-status.js';
import { createInstallClaudeHandler } from './routes/install-claude.js';
import { createAuthClaudeHandler } from './routes/auth-claude.js';
import { createStoreApiKeyHandler } from './routes/store-api-key.js';
import { createDeleteApiKeyHandler } from './routes/delete-api-key.js';
import { createApiKeysHandler } from './routes/api-keys.js';
import { createPlatformHandler } from './routes/platform.js';
import { createVerifyClaudeAuthHandler } from './routes/verify-claude-auth.js';
import { createVerifyCodexAuthHandler } from './routes/verify-codex-auth.js';
import { createGhStatusHandler } from './routes/gh-status.js';
import { createCursorStatusHandler } from './routes/cursor-status.js';
import { createCodexStatusHandler } from './routes/codex-status.js';
import { createInstallCodexHandler } from './routes/install-codex.js';
import { createAuthCodexHandler } from './routes/auth-codex.js';
import { createAuthCursorHandler } from './routes/auth-cursor.js';
import { createDeauthClaudeHandler } from './routes/deauth-claude.js';
import { createDeauthCodexHandler } from './routes/deauth-codex.js';
import { createDeauthCursorHandler } from './routes/deauth-cursor.js';
import { createAuthOpencodeHandler } from './routes/auth-opencode.js';
import { createDeauthOpencodeHandler } from './routes/deauth-opencode.js';
import { createOpencodeStatusHandler } from './routes/opencode-status.js';
import { createGeminiStatusHandler } from './routes/gemini-status.js';
import { createAuthGeminiHandler } from './routes/auth-gemini.js';
import { createDeauthGeminiHandler } from './routes/deauth-gemini.js';
import { createCopilotStatusHandler } from './routes/copilot-status.js';
import { createAuthCopilotHandler } from './routes/auth-copilot.js';
import { createDeauthCopilotHandler } from './routes/deauth-copilot.js';
import {
  createGetCopilotModelsHandler,
  createRefreshCopilotModelsHandler,
  createClearCopilotCacheHandler,
} from './routes/copilot-models.js';
import {
  createGetOpencodeModelsHandler,
  createRefreshOpencodeModelsHandler,
  createGetOpencodeProvidersHandler,
  createClearOpencodeCacheHandler,
} from './routes/opencode-models.js';
import {
  createGetCursorModelsHandler,
  createRefreshCursorModelsHandler,
  createClearCursorCacheHandler,
} from './routes/cursor-models.js';
import {
  createGetClaudeModelsHandler,
  createRefreshClaudeModelsHandler,
  createClearClaudeCacheHandler,
} from './routes/claude-models.js';
import {
  createGetGeminiModelsHandler,
  createRefreshGeminiModelsHandler,
  createClearGeminiCacheHandler,
} from './routes/gemini-models.js';
import { createDiscoverClaudeCompatibleModelsHandler } from './routes/claude-compatible-models.js';
import type { SettingsService } from '../../services/settings-service.js';
import {
  createGetCursorConfigHandler,
  createSetCursorDefaultModelHandler,
  createSetCursorModelsHandler,
  createGetCursorPermissionsHandler,
  createApplyPermissionProfileHandler,
  createSetCustomPermissionsHandler,
  createDeleteProjectPermissionsHandler,
  createGetExampleConfigHandler,
} from './routes/cursor-config.js';

export function createSetupRoutes(settingsService: SettingsService): Router {
  const router = Router();

  router.get('/claude-status', createClaudeStatusHandler());
  router.post('/install-claude', createInstallClaudeHandler());
  router.post('/auth-claude', createAuthClaudeHandler());
  router.post('/deauth-claude', createDeauthClaudeHandler());
  router.post('/store-api-key', createStoreApiKeyHandler());
  router.post('/delete-api-key', createDeleteApiKeyHandler());
  router.get('/api-keys', createApiKeysHandler());
  router.get('/platform', createPlatformHandler());
  router.post('/verify-claude-auth', createVerifyClaudeAuthHandler());
  router.post('/verify-codex-auth', createVerifyCodexAuthHandler());
  router.get('/gh-status', createGhStatusHandler());

  // Cursor CLI routes
  router.get('/cursor-status', createCursorStatusHandler());
  router.post('/auth-cursor', createAuthCursorHandler());
  router.post('/deauth-cursor', createDeauthCursorHandler());

  // Codex CLI routes
  router.get('/codex-status', createCodexStatusHandler());
  router.post('/install-codex', createInstallCodexHandler());
  router.post('/auth-codex', createAuthCodexHandler());
  router.post('/deauth-codex', createDeauthCodexHandler());

  // OpenCode CLI routes
  router.get('/opencode-status', createOpencodeStatusHandler());
  router.post('/auth-opencode', createAuthOpencodeHandler());
  router.post('/deauth-opencode', createDeauthOpencodeHandler());

  // Gemini CLI routes
  router.get('/gemini-status', createGeminiStatusHandler());
  router.post('/auth-gemini', createAuthGeminiHandler());
  router.post('/deauth-gemini', createDeauthGeminiHandler());

  // Copilot CLI routes
  router.get('/copilot-status', createCopilotStatusHandler());
  router.post('/auth-copilot', createAuthCopilotHandler());
  router.post('/deauth-copilot', createDeauthCopilotHandler());

  // Copilot Dynamic Model Discovery routes
  router.get('/copilot/models', createGetCopilotModelsHandler());
  router.post('/copilot/models/refresh', createRefreshCopilotModelsHandler());
  router.post('/copilot/cache/clear', createClearCopilotCacheHandler());

  // OpenCode Dynamic Model Discovery routes
  router.get('/opencode/models', createGetOpencodeModelsHandler());
  router.post('/opencode/models/refresh', createRefreshOpencodeModelsHandler());
  router.get('/opencode/providers', createGetOpencodeProvidersHandler());
  router.post('/opencode/cache/clear', createClearOpencodeCacheHandler());
  router.get('/cursor/models', createGetCursorModelsHandler());
  router.post('/cursor/models/refresh', createRefreshCursorModelsHandler());

  // Claude (Anthropic API) dynamic model routes
  router.get('/claude/models', createGetClaudeModelsHandler(settingsService));
  router.post('/claude/models/refresh', createRefreshClaudeModelsHandler(settingsService));
  router.post('/claude/cache/clear', createClearClaudeCacheHandler());

  // Gemini API dynamic model routes
  router.get('/gemini/models', createGetGeminiModelsHandler(settingsService));
  router.post('/gemini/models/refresh', createRefreshGeminiModelsHandler(settingsService));
  router.post('/gemini/cache/clear', createClearGeminiCacheHandler());

  // Claude-compatible provider (GLM, MiniMax, OpenRouter, custom) model discovery
  router.post(
    '/claude-compatible/models',
    createDiscoverClaudeCompatibleModelsHandler(settingsService)
  );
  router.post('/cursor/cache/clear', createClearCursorCacheHandler());
  router.get('/cursor-config', createGetCursorConfigHandler());
  router.post('/cursor-config/default-model', createSetCursorDefaultModelHandler());
  router.post('/cursor-config/models', createSetCursorModelsHandler());

  // Cursor CLI Permissions routes
  router.get('/cursor-permissions', createGetCursorPermissionsHandler());
  router.post('/cursor-permissions/profile', createApplyPermissionProfileHandler());
  router.post('/cursor-permissions/custom', createSetCustomPermissionsHandler());
  router.delete('/cursor-permissions', createDeleteProjectPermissionsHandler());
  router.get('/cursor-permissions/example', createGetExampleConfigHandler());

  return router;
}
