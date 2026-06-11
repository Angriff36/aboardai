/**
 * Shared types for AI model providers
 *
 * Re-exports types from @aboardai/types for consistency across the codebase.
 * All provider types are defined in @aboardai/types to avoid duplication.
 */

// Re-export all provider types from @aboardai/types
export type {
  ProviderConfig,
  ConversationMessage,
  ExecuteOptions,
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  ContentBlock,
  ProviderMessage,
  InstallationStatus,
  ValidationResult,
  ModelDefinition,
  AgentDefinition,
  ReasoningEffort,
  SystemPromptPreset,
} from '@aboardai/types';
