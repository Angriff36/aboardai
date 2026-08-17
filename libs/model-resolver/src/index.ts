/**
 * @aboardai/model-resolver
 * Model resolution utilities for AboardAI
 */

// Re-export constants from types
export {
  CLAUDE_MODEL_MAP,
  CURSOR_MODEL_MAP,
  DEFAULT_MODELS,
  type ModelAlias,
  type CursorModelId,
} from '@aboardai/types';

// Export resolver functions
export {
  resolveModelString,
  getEffectiveModel,
  resolvePhaseModel,
  type ResolvedPhaseModel,
} from './resolver.js';

export {
  getOrchestrationModelScore,
  selectOrchestrationRoles,
  validateOrchestrationAssignments,
  toOrchestrationModelAssignment,
  type OrchestrationAssignments,
} from './orchestration.js';
