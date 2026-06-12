/**
 * AboardAI In-Process Agent Tool Server
 *
 * Exposes a set of board-mutation tools to the Claude agent SDK via an in-process
 * MCP server created with `createSdkMcpServer`. Agents see these tools as:
 *   mcp__aboardai__update_feature_status
 *   mcp__aboardai__get_feature
 *
 * Scope guard (A2 scoped): feature status update + read only.
 * No group commands, no deletes — those are deferred to post-v1 roadmap.
 *
 * Legal statuses exposed to agents (non-pipeline, agent-settable):
 *   backlog, ready, waiting_approval, verified, completed
 * Excluded from the tool (set by system/infra, not agents):
 *   in_progress     — set by the executor at run start
 *   interrupted     — set on abort/crash
 *   merge_conflict  — set by git operations
 *   pipeline_*      — set by the pipeline orchestrator
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfig } from '@aboardai/types';
import type { Feature } from '@aboardai/types';
import { createLogger } from '@aboardai/utils';

const logger = createLogger('AgentTools');

/**
 * The MCP server name used to prefix tool names.
 * Agents see tools as `mcp__aboardai__<toolname>`.
 */
export const ABOARDAI_MCP_SERVER_NAME = 'aboardai';

/**
 * Fully-qualified tool names agents will see in their context.
 */
export const AGENT_TOOL_NAMES = {
  updateFeatureStatus: `mcp__${ABOARDAI_MCP_SERVER_NAME}__update_feature_status`,
  getFeature: `mcp__${ABOARDAI_MCP_SERVER_NAME}__get_feature`,
} as const;

/**
 * Statuses that agents are allowed to set on features.
 * These are the non-pipeline statuses that represent intentional agent decisions.
 * Statuses excluded and WHY:
 *   in_progress    — set by executor at run start; agents must not overwrite it
 *   interrupted    — set on abort/crash; set by system
 *   merge_conflict — set by git layer; not an agent decision
 *   pipeline_*     — dynamic; set by pipeline orchestrator
 */
export const AGENT_SETTABLE_STATUSES = [
  'backlog',
  'ready',
  'waiting_approval',
  'verified',
  'completed',
] as const;

export type AgentSettableStatus = (typeof AGENT_SETTABLE_STATUSES)[number];

/**
 * Dependencies injected into the aboardai tool server.
 * Each method is bound to the project context at creation time.
 */
export interface AboardaiToolDeps {
  /** Update feature status; delegates to FeatureStateManager (persist-before-emit). */
  updateFeatureStatus(projectPath: string, featureId: string, status: string): Promise<void>;
  /** Read feature snapshot; delegates to FeatureLoader. */
  getFeature(projectPath: string, featureId: string): Promise<Feature | null>;
  /** Absolute path to the project — injected so tools don't need it as a param. */
  projectPath: string;
}

/**
 * Build and return the AboardAI in-process MCP server.
 *
 * Returns a `McpSdkServerConfig` (extends `McpSdkServerConfigWithInstance`) that can be
 * spread into `CreateSdkOptionsConfig.mcpServers` or `ExecuteOptions.mcpServers`.
 *
 * @example
 * ```ts
 * const aboardaiServer = createAboardaiToolsServer({ updateFeatureStatus, getFeature, projectPath });
 * const opts = createAutoModeOptions({ ..., mcpServers: { aboardai: aboardaiServer } });
 * ```
 */
export function createAboardaiToolsServer(deps: AboardaiToolDeps): McpSdkServerConfig {
  const updateStatusTool = tool(
    'update_feature_status',
    `Update the status of a feature on the AboardAI board.
Allowed statuses: ${AGENT_SETTABLE_STATUSES.join(', ')}.
Use 'waiting_approval' when your implementation is ready for human review.
Use 'verified' to mark a feature as confirmed working after review.
Use 'completed' when the feature is fully done and merged.
Use 'backlog' or 'ready' to move a feature back to an earlier stage.
Do NOT use this to set 'in_progress', 'interrupted', or 'merge_conflict' — those are managed by the system.`,
    {
      featureId: z.string().describe('The feature ID to update (e.g., "user-auth-feature")'),
      status: z
        .enum(AGENT_SETTABLE_STATUSES)
        .describe('New status value. Must be one of: ' + AGENT_SETTABLE_STATUSES.join(', ')),
    },
    async ({ featureId, status }) => {
      logger.info(
        `[agent-tool] update_feature_status: featureId=${featureId}, status=${status}, project=${deps.projectPath}`
      );
      try {
        await deps.updateFeatureStatus(deps.projectPath, featureId, status);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, featureId, status }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[agent-tool] update_feature_status error: ${message}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: message, featureId, status }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  const getFeatureTool = tool(
    'get_feature',
    'Read the current state of a feature from the AboardAI board. Returns the feature JSON snapshot including status, title, description, and planSpec.',
    {
      featureId: z.string().describe('The feature ID to read (e.g., "user-auth-feature")'),
    },
    async ({ featureId }) => {
      logger.info(`[agent-tool] get_feature: featureId=${featureId}, project=${deps.projectPath}`);
      try {
        const feature = await deps.getFeature(deps.projectPath, featureId);
        if (!feature) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: false, error: `Feature '${featureId}' not found` }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, feature }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[agent-tool] get_feature error: ${message}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: message, featureId }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  const sdkServer = createSdkMcpServer({
    name: ABOARDAI_MCP_SERVER_NAME,
    tools: [updateStatusTool, getFeatureTool],
  });

  // Cast to our widened McpServerConfig that includes McpSdkServerConfig.
  // McpSdkServerConfigWithInstance from the SDK is structurally compatible:
  //   { type: 'sdk', name: string, instance: McpServer }
  return sdkServer as unknown as McpSdkServerConfig;
}
