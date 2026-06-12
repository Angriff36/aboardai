/**
 * AgentExecutor - Core agent execution engine with streaming support
 */

import path from 'path';
import type { ExecuteOptions, ParsedTask } from '@aboardai/types';
import {
  isPipelineStatus,
  DEFAULT_SUPERVISOR_POLICY,
  SupervisorExhaustedError,
} from '@aboardai/types';
import { buildPromptWithImages, createLogger, isAuthenticationError } from '@aboardai/utils';
import { getFeatureDir } from '@aboardai/platform';
import { superviseQuery } from '../providers/provider-supervisor.js';
import * as secureFs from '../lib/secure-fs.js';
import { TypedEventBus } from './typed-event-bus.js';
import { FeatureStateManager } from './feature-state-manager.js';
import { PlanApprovalService } from './plan-approval-service.js';
import type { SettingsService } from './settings-service.js';
import { parseTasksFromSpec, detectSpecFallback, extractSummary } from './spec-parser.js';
import { getPromptCustomization } from '../lib/settings-helpers.js';
import type {
  AgentExecutionOptions,
  AgentExecutionResult,
  AgentExecutorCallbacks,
} from './agent-executor-types.js';
import { NormalizedEventStream } from '../events/normalizer.js';
import { EventLogWriter } from '../events/event-log.js';

// Re-export types for backward compatibility
export type {
  AgentExecutionOptions,
  AgentExecutionResult,
  WaitForApprovalFn,
  SaveFeatureSummaryFn,
  UpdateFeatureSummaryFn,
  BuildTaskPromptFn,
} from './agent-executor-types.js';

const logger = createLogger('AgentExecutor');

const DEFAULT_MAX_TURNS = 10000;

export class AgentExecutor {
  private static readonly WRITE_DEBOUNCE_MS = 500;
  private static readonly STREAM_HEARTBEAT_MS = 15_000;

  /**
   * Sanitize a provider error value into clean text.
   * Coalesces to string, removes ANSI codes, strips leading "Error:" prefix,
   * trims, and returns 'Unknown error' when empty.
   */
  private static sanitizeProviderError(input: string | { error?: string } | undefined): string {
    let raw: string;
    if (typeof input === 'string') {
      raw = input;
    } else if (input && typeof input === 'object' && typeof input.error === 'string') {
      raw = input.error;
    } else {
      raw = '';
    }
    const cleaned = raw
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    return cleaned || 'Unknown error';
  }

  constructor(
    private eventBus: TypedEventBus,
    private featureStateManager: FeatureStateManager,
    private planApprovalService: PlanApprovalService,
    private settingsService: SettingsService | null = null
  ) {}

  async execute(
    options: AgentExecutionOptions,
    callbacks: AgentExecutorCallbacks
  ): Promise<AgentExecutionResult> {
    const {
      workDir,
      featureId,
      projectPath,
      abortController,
      branchName = null,
      provider,
      effectiveBareModel,
      previousContent,
      planningMode = 'skip',
      requirePlanApproval = false,
      specAlreadyDetected = false,
      existingApprovedPlanContent,
      persistedTasks,
      credentials,
      status, // Feature status for pipeline summary check
      claudeCompatibleProvider,
      mcpServers,
      sdkSessionId,
      sdkOptions,
    } = options;
    const { content: promptContent } = await buildPromptWithImages(
      options.prompt,
      options.imagePaths,
      workDir,
      false
    );
    const resolvedMaxTurns = sdkOptions?.maxTurns ?? DEFAULT_MAX_TURNS;
    if (sdkOptions?.maxTurns == null) {
      logger.info(
        `[execute] Feature ${featureId}: sdkOptions.maxTurns is not set, defaulting to ${resolvedMaxTurns}. ` +
          `Model: ${effectiveBareModel}`
      );
    } else {
      logger.info(
        `[execute] Feature ${featureId}: maxTurns=${resolvedMaxTurns}, model=${effectiveBareModel}`
      );
    }

    const executeOptions: ExecuteOptions = {
      prompt: promptContent,
      model: effectiveBareModel,
      maxTurns: resolvedMaxTurns,
      cwd: workDir,
      allowedTools: sdkOptions?.allowedTools as string[] | undefined,
      abortController,
      systemPrompt: sdkOptions?.systemPrompt,
      settingSources: sdkOptions?.settingSources,
      mcpServers:
        mcpServers && Object.keys(mcpServers).length > 0
          ? (mcpServers as Record<string, { command: string }>)
          : undefined,
      thinkingLevel: options.thinkingLevel,
      reasoningEffort: options.reasoningEffort,
      credentials,
      claudeCompatibleProvider,
      sdkSessionId,
    };
    const featureDirForOutput = getFeatureDir(projectPath, featureId);
    const outputPath = path.join(featureDirForOutput, 'agent-output.md');
    const rawOutputPath = path.join(featureDirForOutput, 'raw-output.jsonl');
    const enableRawOutput =
      process.env.ABOARDAI_DEBUG_RAW_OUTPUT === 'true' ||
      process.env.ABOARDAI_DEBUG_RAW_OUTPUT === '1';
    let responseText = previousContent
      ? `${previousContent}\n\n---\n\n## Follow-up Session\n\n`
      : '';

    // One EventLogWriter per execute() invocation (shared across inner loops in this run).
    // Each inner provider-call loop creates its own NormalizedEventStream for session-slice
    // semantics; all streams feed the same writer and broadcast on the same bus.
    const eventLogWriter = new EventLogWriter({ projectPath, featureId });
    const providerName = provider.getName();
    let specDetected = specAlreadyDetected,
      tasksCompleted = 0,
      aborted = false;
    let writeTimeout: ReturnType<typeof setTimeout> | null = null,
      rawOutputLines: string[] = [],
      rawWriteTimeout: ReturnType<typeof setTimeout> | null = null;

    const writeToFile = async (): Promise<void> => {
      try {
        await secureFs.mkdir(path.dirname(outputPath), { recursive: true });
        await secureFs.writeFile(outputPath, responseText);
      } catch (error) {
        logger.error(`Failed to write agent output for ${featureId}:`, error);
      }
    };
    const scheduleWrite = (): void => {
      if (writeTimeout) clearTimeout(writeTimeout);
      writeTimeout = setTimeout(() => writeToFile(), AgentExecutor.WRITE_DEBOUNCE_MS);
    };
    const appendRawEvent = (event: unknown): void => {
      if (!enableRawOutput) return;
      try {
        rawOutputLines.push(JSON.stringify({ timestamp: new Date().toISOString(), event }));
        if (rawWriteTimeout) clearTimeout(rawWriteTimeout);
        rawWriteTimeout = setTimeout(async () => {
          try {
            await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
            await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
            rawOutputLines = [];
          } catch {
            /* ignore */
          }
        }, AgentExecutor.WRITE_DEBOUNCE_MS);
      } catch {
        /* ignore */
      }
    };

    const streamStartTime = Date.now();
    let receivedAnyStreamMessage = false;
    const streamHeartbeat = setInterval(() => {
      if (!receivedAnyStreamMessage)
        logger.info(
          `Waiting for first model response for feature ${featureId} (${Math.round((Date.now() - streamStartTime) / 1000)}s elapsed)...`
        );
    }, AgentExecutor.STREAM_HEARTBEAT_MS);
    const planningModeRequiresApproval =
      planningMode === 'spec' ||
      planningMode === 'full' ||
      (planningMode === 'lite' && requirePlanApproval);
    const requiresApproval = planningModeRequiresApproval && requirePlanApproval;

    if (existingApprovedPlanContent && persistedTasks && persistedTasks.length > 0) {
      const result = await this.executeTasksLoop(
        options,
        persistedTasks,
        existingApprovedPlanContent,
        responseText,
        scheduleWrite,
        callbacks,
        undefined,
        eventLogWriter
      );
      clearInterval(streamHeartbeat);
      if (writeTimeout) clearTimeout(writeTimeout);
      if (rawWriteTimeout) clearTimeout(rawWriteTimeout);
      await writeToFile();
      await eventLogWriter.close();

      // Extract and save summary from the new content generated in this session
      await this.extractAndSaveSessionSummary(
        projectPath,
        featureId,
        result.responseText,
        previousContent,
        callbacks,
        status,
        result.pipelineSummaryFromStream
      );

      return {
        responseText: result.responseText,
        specDetected: true,
        tasksCompleted: result.tasksCompleted,
        aborted: result.aborted,
      };
    }

    logger.info(`Starting stream for feature ${featureId}...`);

    // One NormalizedEventStream per provider-call (session-slice semantics).
    const normalizedStream = new NormalizedEventStream({ provider: providerName, featureId });
    let mainStreamSummary: string | undefined;

    try {
      const stream = superviseQuery(provider, executeOptions, DEFAULT_SUPERVISOR_POLICY);
      try {
        streamLoop: for await (const msg of stream) {
          if (msg.session_id && msg.session_id !== options.sdkSessionId) {
            options.sdkSessionId = msg.session_id;
          }
          receivedAnyStreamMessage = true;
          appendRawEvent(msg);

          // Feed into the normalized event pipeline
          const normalizedEvents = normalizedStream.feed(msg);
          for (const evt of normalizedEvents) {
            eventLogWriter.append(evt);
            this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
          }

          // supervisor_status messages have no content — skip sentinel parsing and emit progress
          // NOTE: abort check is below so supervisor_status is skipped without triggering it
          if (msg.type === 'supervisor_status') {
            const sv = msg as unknown as import('@aboardai/types').SupervisorStatusMessage;
            if (sv.status === 'rate_limited') {
              const waitSec = sv.retryAfterMs != null ? Math.round(sv.retryAfterMs / 1000) : '?';
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Rate limited — waiting ${waitSec}s before resuming (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'stalled') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Stream stalled — resuming with session ID (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'reconnecting') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Connection lost — reconnecting (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'resumed') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Resumed stream successfully`,
              });
            }
            continue;
          }
          if (abortController.signal.aborted) {
            aborted = true;
            throw new Error('Feature execution aborted');
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                const newText = block.text || '';
                if (!newText) continue;
                if (responseText.length > 0 && newText.length > 0) {
                  const endsWithSentence = /[.!?:]\s*$/.test(responseText),
                    endsWithNewline = /\n\s*$/.test(responseText);
                  if (
                    !endsWithNewline &&
                    (endsWithSentence || /^[\n#\-*>]/.test(newText)) &&
                    !/[a-zA-Z0-9]/.test(responseText.slice(-1))
                  )
                    responseText += '\n\n';
                }
                responseText += newText;
                // Check for authentication errors using provider-agnostic utility
                if (block.text && isAuthenticationError(block.text))
                  throw new Error(
                    'Authentication failed: Invalid or expired API key. Please check your API key configuration or re-authenticate with your provider.'
                  );
                scheduleWrite();
                const hasExplicitMarker = responseText.includes('[SPEC_GENERATED]'),
                  hasFallbackSpec = !hasExplicitMarker && detectSpecFallback(responseText);
                if (
                  planningModeRequiresApproval &&
                  !specDetected &&
                  (hasExplicitMarker || hasFallbackSpec)
                ) {
                  specDetected = true;
                  const planContent = hasExplicitMarker
                    ? responseText.substring(0, responseText.indexOf('[SPEC_GENERATED]')).trim()
                    : responseText.trim();
                  if (!hasExplicitMarker)
                    logger.info(`Using fallback spec detection for feature ${featureId}`);
                  const result = await this.handleSpecGenerated(
                    options,
                    planContent,
                    responseText,
                    requiresApproval,
                    scheduleWrite,
                    callbacks,
                    eventLogWriter
                  );
                  responseText = result.responseText;
                  tasksCompleted = result.tasksCompleted;
                  break streamLoop;
                }
                if (!specDetected)
                  this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                    featureId,
                    branchName,
                    content: block.text,
                  });
              } else if (block.type === 'tool_use') {
                this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                  featureId,
                  branchName,
                  tool: block.name,
                  input: block.input,
                });
                if (responseText.length > 0 && !responseText.endsWith('\n')) responseText += '\n';
                responseText += `\n🔧 Tool: ${block.name}\n`;
                if (block.input) responseText += `Input: ${JSON.stringify(block.input, null, 2)}\n`;
                scheduleWrite();
              }
            }
          } else if (msg.type === 'error') {
            const sanitized = AgentExecutor.sanitizeProviderError(msg.error);
            logger.error(
              `[execute] Feature ${featureId} received error from provider. ` +
                `raw="${msg.error}", sanitized="${sanitized}", session_id=${msg.session_id ?? 'none'}`
            );
            throw new Error(sanitized);
          } else if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              scheduleWrite();
            } else if (msg.subtype?.startsWith('error')) {
              // Non-success result subtypes from the SDK (error_max_turns, error_during_execution, etc.)
              logger.error(
                `[execute] Feature ${featureId} ended with error subtype: ${msg.subtype}. ` +
                  `session_id=${msg.session_id ?? 'none'}`
              );
              throw new Error(`Agent execution ended with: ${msg.subtype}`);
            } else {
              logger.warn(
                `[execute] Feature ${featureId} received unhandled result subtype: ${msg.subtype}`
              );
            }
          }
        }
      } catch (streamErr) {
        if (streamErr instanceof SupervisorExhaustedError) {
          logger.error(
            `[execute] Supervisor exhausted for feature ${featureId}: ` +
              `attempts=${streamErr.attempts}, classification=${streamErr.classification}`
          );
          // Mark the feature as 'interrupted' so it can be resumed later
          try {
            await this.featureStateManager.markFeatureInterrupted(
              projectPath,
              featureId,
              `Supervisor exhausted after ${streamErr.attempts} attempts`
            );
          } catch (markErr) {
            logger.error(`[execute] Failed to mark feature ${featureId} as interrupted:`, markErr);
          }
        }
        throw streamErr;
      } finally {
        // Finalize the normalized stream: emit summary event (if any)
        // NOTE: eventLogWriter.close() is called in the outer finally to ensure it stays
        // open across handleSpecGenerated / executeTasksLoop calls (which share the writer).
        const finalizeEvents = normalizedStream.finalize();
        for (const evt of finalizeEvents) {
          if (evt.kind === 'summary' && evt.text) {
            mainStreamSummary = evt.text;
          }
          eventLogWriter.append(evt);
          this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
        }
      }
    } finally {
      clearInterval(streamHeartbeat);
      if (writeTimeout) clearTimeout(writeTimeout);
      if (rawWriteTimeout) clearTimeout(rawWriteTimeout);

      const streamElapsedMs = Date.now() - streamStartTime;
      logger.info(
        `[execute] Stream ended for feature ${featureId} after ${Math.round(streamElapsedMs / 1000)}s. ` +
          `aborted=${aborted}, specDetected=${specDetected}, responseLength=${responseText.length}`
      );

      await writeToFile();
      if (enableRawOutput && rawOutputLines.length > 0) {
        try {
          await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
          await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
        } catch {
          /* ignore */
        }
      }
      // Always close the event log writer at the very end of execute()
      await eventLogWriter.close();
    }

    // Capture summary if it hasn't been captured by handleSpecGenerated or executeTasksLoop
    // or if we're in a simple execution mode (planningMode='skip')
    await this.extractAndSaveSessionSummary(
      projectPath,
      featureId,
      responseText,
      previousContent,
      callbacks,
      status,
      mainStreamSummary
    );

    return { responseText, specDetected, tasksCompleted, aborted };
  }

  /**
   * Strip the follow-up session scaffold marker from content.
   * The scaffold is added when resuming a session with previous content:
   *   "\n\n---\n\n## Follow-up Session\n\n"
   * This ensures fallback summaries don't include the scaffold header.
   *
   * The regex pattern handles variations in whitespace while matching the
   * scaffold structure: dashes followed by "## Follow-up Session" at the
   * start of the content.
   */
  private static stripFollowUpScaffold(content: string): string {
    // Pattern matches: ^\s*---\s*##\s*Follow-up Session\s*
    // - ^ = start of content (scaffold is always at the beginning of sessionContent)
    // - \s* = any whitespace (handles \n\n before ---, spaces/tabs between markers)
    // - --- = literal dashes
    // - \s* = whitespace between dashes and heading
    // - ## = heading marker
    // - \s* = whitespace before "Follow-up"
    // - Follow-up Session = literal heading text
    // - \s* = trailing whitespace/newlines after heading
    const scaffoldPattern = /^\s*---\s*##\s*Follow-up Session\s*/;
    return content.replace(scaffoldPattern, '');
  }

  /**
   * Extract summary ONLY from the new content generated in this session
   * and save it via the provided callback.
   *
   * Summary resolution order:
   * 1. pipelineSummaryFromStream — 'summary' event produced by NormalizedEventStream.finalize()
   *    for this run (same text as extractSummary would find, but pre-extracted).
   * 2. extractSummary(sessionContent) — fallback scan of the session content slice.
   * 3. Pipeline-status fallback — when no summary is found but status is a pipeline step,
   *    use the cleaned session content as the summary (unchanged from pre-Phase-3 behaviour).
   */
  private async extractAndSaveSessionSummary(
    projectPath: string,
    featureId: string,
    responseText: string,
    previousContent: string | undefined,
    callbacks: AgentExecutorCallbacks,
    status?: string,
    pipelineSummaryFromStream?: string
  ): Promise<void> {
    // 1. Use the summary emitted by the normalizer's finalize() if available
    if (pipelineSummaryFromStream) {
      await callbacks.saveFeatureSummary(projectPath, featureId, pipelineSummaryFromStream);
      return;
    }

    const sessionContent = responseText.substring(previousContent ? previousContent.length : 0);
    // 2. Fall back to scanning sessionContent directly (preserves pre-Phase-3 behaviour)
    const summary = extractSummary(sessionContent);
    if (summary) {
      await callbacks.saveFeatureSummary(projectPath, featureId, summary);
      return;
    }

    // 3. If we're in a pipeline step, a summary is expected. Use a fallback if extraction fails.
    if (isPipelineStatus(status)) {
      // Strip any follow-up session scaffold before using as fallback
      const cleanSessionContent = AgentExecutor.stripFollowUpScaffold(sessionContent);
      const fallback = cleanSessionContent.trim();
      if (fallback) {
        await callbacks.saveFeatureSummary(projectPath, featureId, fallback);
      }
      logger.warn(
        `[AgentExecutor] Mandatory summary extraction failed for pipeline feature ${featureId} (status="${status}")`
      );
    }
  }

  private async executeTasksLoop(
    options: AgentExecutionOptions,
    tasks: ParsedTask[],
    planContent: string,
    initialResponseText: string,
    scheduleWrite: () => void,
    callbacks: AgentExecutorCallbacks,
    userFeedback?: string,
    eventLogWriter?: EventLogWriter
  ): Promise<{
    responseText: string;
    tasksCompleted: number;
    aborted: boolean;
    pipelineSummaryFromStream?: string;
  }> {
    const {
      featureId,
      projectPath,
      abortController,
      branchName = null,
      provider,
      sdkOptions,
    } = options;
    const providerName = provider.getName();
    logger.info(`Starting task execution for feature ${featureId} with ${tasks.length} tasks`);
    const taskPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    let responseText = initialResponseText,
      tasksCompleted = 0;
    let loopSummary: string | undefined;

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];
      if (task.status === 'completed') {
        tasksCompleted++;
        continue;
      }
      if (abortController.signal.aborted) return { responseText, tasksCompleted, aborted: true };
      await this.featureStateManager.updateTaskStatus(
        projectPath,
        featureId,
        task.id,
        'in_progress'
      );
      this.eventBus.emitAutoModeEvent('auto_mode_task_started', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        taskDescription: task.description,
        taskIndex,
        tasksTotal: tasks.length,
      });
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        currentTaskId: task.id,
      });
      const taskPrompt = callbacks.buildTaskPrompt(
        task,
        tasks,
        taskIndex,
        planContent,
        taskPrompts.taskExecution.taskPromptTemplate,
        userFeedback
      );
      const taskMaxTurns = sdkOptions?.maxTurns ?? DEFAULT_MAX_TURNS;
      logger.info(
        `[executeTasksLoop] Feature ${featureId}, task ${task.id} (${taskIndex + 1}/${tasks.length}): ` +
          `maxTurns=${taskMaxTurns} (sdkOptions.maxTurns=${sdkOptions?.maxTurns ?? 'undefined'})`
      );
      const taskStream = superviseQuery(
        provider,
        this.buildExecOpts(options, taskPrompt, taskMaxTurns),
        DEFAULT_SUPERVISOR_POLICY
      );
      let taskOutput = '',
        taskStartDetected = false,
        taskCompleteDetected = false;

      // Fresh NormalizedEventStream per task loop (session-slice semantics)
      const taskNormStream = new NormalizedEventStream({ provider: providerName, featureId });

      try {
        for await (const msg of taskStream) {
          if (msg.session_id && msg.session_id !== options.sdkSessionId) {
            options.sdkSessionId = msg.session_id;
          }

          // Feed into the normalized event pipeline
          const normalizedEvents = taskNormStream.feed(msg);
          for (const evt of normalizedEvents) {
            eventLogWriter?.append(evt);
            this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });

            // React to task_marker events instead of direct detect* calls
            if (evt.kind === 'task_marker' && evt.marker) {
              const { type: markerType, taskId, phase, summary: markerSummary } = evt.marker;
              if (markerType === 'task_start' && taskId && !taskStartDetected) {
                taskStartDetected = true;
                await this.featureStateManager.updateTaskStatus(
                  projectPath,
                  featureId,
                  taskId,
                  'in_progress'
                );
              } else if (markerType === 'task_complete' && taskId && !taskCompleteDetected) {
                taskCompleteDetected = true;
                await this.featureStateManager.updateTaskStatus(
                  projectPath,
                  featureId,
                  taskId,
                  'completed',
                  markerSummary
                );
              } else if (markerType === 'phase_complete' && phase !== undefined) {
                this.eventBus.emitAutoModeEvent('auto_mode_phase_complete', {
                  featureId,
                  projectPath,
                  branchName,
                  phaseNumber: phase,
                });
              }
            }
          }

          // supervisor_status messages have no content — emit progress and skip sentinel detection
          if (msg.type === 'supervisor_status') {
            const sv = msg as unknown as import('@aboardai/types').SupervisorStatusMessage;
            if (sv.status === 'rate_limited') {
              const waitSec = sv.retryAfterMs != null ? Math.round(sv.retryAfterMs / 1000) : '?';
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Rate limited — waiting ${waitSec}s before resuming (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'stalled') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Stream stalled — resuming with session ID (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'reconnecting') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Connection lost — reconnecting (attempt ${sv.attempt ?? '?'})`,
              });
            } else if (sv.status === 'resumed') {
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: `Resumed stream successfully`,
              });
            }
            continue;
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const b of msg.message.content) {
              if (b.type === 'text') {
                const text = b.text || '';
                taskOutput += text;
                responseText += text;
                this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                  featureId,
                  branchName,
                  content: text,
                });
                scheduleWrite();
              } else if (b.type === 'tool_use')
                this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                  featureId,
                  branchName,
                  tool: b.name,
                  input: b.input,
                });
            }
          } else if (msg.type === 'error') {
            const fallback = `Error during task ${task.id}`;
            const sanitized = AgentExecutor.sanitizeProviderError(msg.error || fallback);
            logger.error(
              `[executeTasksLoop] Feature ${featureId} task ${task.id} received error from provider. ` +
                `raw="${msg.error}", sanitized="${sanitized}", session_id=${msg.session_id ?? 'none'}`
            );
            throw new Error(sanitized);
          } else if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              taskOutput += msg.result || '';
              responseText += msg.result || '';
            } else if (msg.subtype?.startsWith('error')) {
              logger.error(
                `[executeTasksLoop] Feature ${featureId} task ${task.id} ended with error subtype: ${msg.subtype}. ` +
                  `session_id=${msg.session_id ?? 'none'}`
              );
              throw new Error(`Agent execution ended with: ${msg.subtype}`);
            } else {
              logger.warn(
                `[executeTasksLoop] Feature ${featureId} task ${task.id} received unhandled result subtype: ${msg.subtype}`
              );
            }
          }
        }
      } finally {
        // Finalize the task's normalized stream and flush any summary event
        const taskFinalizeEvents = taskNormStream.finalize();
        for (const evt of taskFinalizeEvents) {
          if (evt.kind === 'summary' && evt.text) {
            loopSummary = evt.text;
          }
          eventLogWriter?.append(evt);
          this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
        }
      }

      if (!taskCompleteDetected)
        await this.featureStateManager.updateTaskStatus(
          projectPath,
          featureId,
          task.id,
          'completed'
        );
      tasksCompleted = taskIndex + 1;
      this.eventBus.emitAutoModeEvent('auto_mode_task_complete', {
        featureId,
        projectPath,
        branchName,
        taskId: task.id,
        tasksCompleted,
        tasksTotal: tasks.length,
      });
      await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
        tasksCompleted,
      });
      if (task.phase) {
        const next = tasks[taskIndex + 1];
        if (!next || next.phase !== task.phase) {
          const m = task.phase.match(/Phase\s*(\d+)/i);
          if (m)
            this.eventBus.emitAutoModeEvent('auto_mode_phase_complete', {
              featureId,
              projectPath,
              branchName,
              phaseNumber: parseInt(m[1], 10),
            });
        }
      }
    }
    return { responseText, tasksCompleted, aborted: false, pipelineSummaryFromStream: loopSummary };
  }

  private async handleSpecGenerated(
    options: AgentExecutionOptions,
    planContent: string,
    initialResponseText: string,
    requiresApproval: boolean,
    scheduleWrite: () => void,
    callbacks: AgentExecutorCallbacks,
    eventLogWriter?: EventLogWriter
  ): Promise<{ responseText: string; tasksCompleted: number }> {
    const {
      featureId,
      projectPath,
      branchName = null,
      planningMode = 'skip',
      provider,
      sdkOptions,
    } = options;
    let responseText = initialResponseText,
      parsedTasks = parseTasksFromSpec(planContent);
    logger.info(`Parsed ${parsedTasks.length} tasks from spec for feature ${featureId}`);
    await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
      status: 'generated',
      content: planContent,
      version: 1,
      generatedAt: new Date().toISOString(),
      reviewedByUser: false,
      tasks: parsedTasks,
      tasksTotal: parsedTasks.length,
      tasksCompleted: 0,
    });
    const planSummary = extractSummary(planContent);
    if (planSummary) await callbacks.updateFeatureSummary(projectPath, featureId, planSummary);
    let approvedPlanContent = planContent,
      userFeedback: string | undefined,
      currentPlanContent = planContent,
      planVersion = 1;

    if (requiresApproval) {
      let planApproved = false;
      while (!planApproved) {
        logger.info(
          `Spec v${planVersion} generated for feature ${featureId}, waiting for approval`
        );
        this.eventBus.emitAutoModeEvent('plan_approval_required', {
          featureId,
          projectPath,
          branchName,
          planContent: currentPlanContent,
          planningMode,
          planVersion,
        });
        const approvalResult = await callbacks.waitForApproval(featureId, projectPath);
        if (approvalResult.approved) {
          planApproved = true;
          userFeedback = approvalResult.feedback;
          approvedPlanContent = approvalResult.editedPlan || currentPlanContent;
          if (approvalResult.editedPlan) {
            // Re-parse tasks from edited plan to ensure we execute the updated tasks
            const editedTasks = parseTasksFromSpec(approvalResult.editedPlan);
            parsedTasks = editedTasks;
            await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
              content: approvalResult.editedPlan,
              tasks: editedTasks,
              tasksTotal: editedTasks.length,
              tasksCompleted: 0,
            });
          }
          this.eventBus.emitAutoModeEvent('plan_approved', {
            featureId,
            projectPath,
            branchName,
            hasEdits: !!approvalResult.editedPlan,
            planVersion,
          });
        } else {
          const hasFeedback = approvalResult.feedback?.trim().length,
            hasEdits = approvalResult.editedPlan?.trim().length;
          if (!hasFeedback && !hasEdits) throw new Error('Plan cancelled by user');
          planVersion++;
          this.eventBus.emitAutoModeEvent('plan_revision_requested', {
            featureId,
            projectPath,
            branchName,
            feedback: approvalResult.feedback,
            hasEdits: !!hasEdits,
            planVersion,
          });
          const revPrompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
          const taskEx =
            planningMode === 'full'
              ? '```tasks\n## Phase 1: Foundation\n- [ ] T001: [Description] | File: [path/to/file]\n```'
              : '```tasks\n- [ ] T001: [Description] | File: [path/to/file]\n```';
          let revPrompt = revPrompts.taskExecution.planRevisionTemplate
            .replace(/\{\{planVersion\}\}/g, String(planVersion - 1))
            .replace(
              /\{\{previousPlan\}\}/g,
              hasEdits ? approvalResult.editedPlan || currentPlanContent : currentPlanContent
            )
            .replace(
              /\{\{userFeedback\}\}/g,
              approvalResult.feedback || 'Please revise the plan based on the edits above.'
            )
            .replace(/\{\{planningMode\}\}/g, planningMode)
            .replace(/\{\{taskFormatExample\}\}/g, taskEx);
          await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'generating',
            version: planVersion,
          });
          let revText = '';
          const revNormStream = new NormalizedEventStream({
            provider: provider.getName(),
            featureId,
          });
          try {
            for await (const msg of superviseQuery(
              provider,
              this.buildExecOpts(options, revPrompt, sdkOptions?.maxTurns ?? DEFAULT_MAX_TURNS),
              DEFAULT_SUPERVISOR_POLICY
            )) {
              if (msg.session_id && msg.session_id !== options.sdkSessionId) {
                options.sdkSessionId = msg.session_id;
              }

              // Feed into the normalized event pipeline
              const normalizedEvents = revNormStream.feed(msg);
              for (const evt of normalizedEvents) {
                eventLogWriter?.append(evt);
                this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
              }

              if (msg.type === 'supervisor_status') continue; // no content, skip
              if (msg.type === 'assistant' && msg.message?.content)
                for (const b of msg.message.content)
                  if (b.type === 'text') {
                    revText += b.text || '';
                    this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                      featureId,
                      branchName,
                      content: b.text,
                    });
                  }
              if (msg.type === 'error') {
                const cleanedError =
                  (msg.error || 'Error during plan revision')
                    .replace(/\x1b\[[0-9;]*m/g, '')
                    .replace(/^Error:\s*/i, '')
                    .trim() || 'Error during plan revision';
                throw new Error(cleanedError);
              }
              if (msg.type === 'result' && msg.subtype === 'success') revText += msg.result || '';
            }
          } finally {
            const revFinalizeEvents = revNormStream.finalize();
            for (const evt of revFinalizeEvents) {
              eventLogWriter?.append(evt);
              this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
            }
          }
          const mi = revText.indexOf('[SPEC_GENERATED]');
          currentPlanContent = mi > 0 ? revText.substring(0, mi).trim() : revText.trim();
          const revisedTasks = parseTasksFromSpec(currentPlanContent);
          if (revisedTasks.length === 0 && (planningMode === 'spec' || planningMode === 'full'))
            this.eventBus.emitAutoModeEvent('plan_revision_warning', {
              featureId,
              projectPath,
              branchName,
              planningMode,
              warning: 'Revised plan missing tasks block',
            });
          await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
            status: 'generated',
            content: currentPlanContent,
            version: planVersion,
            tasks: revisedTasks,
            tasksTotal: revisedTasks.length,
            tasksCompleted: 0,
          });
          parsedTasks = revisedTasks;
          responseText += revText;
        }
      }
    } else {
      this.eventBus.emitAutoModeEvent('plan_auto_approved', {
        featureId,
        projectPath,
        branchName,
        planContent,
        planningMode,
      });
    }
    await this.featureStateManager.updateFeaturePlanSpec(projectPath, featureId, {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      reviewedByUser: requiresApproval,
    });
    let tasksCompleted = 0;
    if (parsedTasks.length > 0) {
      const r = await this.executeTasksLoop(
        options,
        parsedTasks,
        approvedPlanContent,
        responseText,
        scheduleWrite,
        callbacks,
        userFeedback,
        eventLogWriter
      );
      responseText = r.responseText;
      tasksCompleted = r.tasksCompleted;
    } else {
      const r = await this.executeSingleAgentContinuation(
        options,
        approvedPlanContent,
        userFeedback,
        responseText,
        eventLogWriter
      );
      responseText = r.responseText;
    }
    return { responseText, tasksCompleted };
  }

  private buildExecOpts(o: AgentExecutionOptions, prompt: string, maxTurns: number) {
    return {
      prompt,
      model: o.effectiveBareModel,
      maxTurns,
      cwd: o.workDir,
      allowedTools: o.sdkOptions?.allowedTools as string[] | undefined,
      abortController: o.abortController,
      thinkingLevel: o.thinkingLevel,
      reasoningEffort: o.reasoningEffort,
      mcpServers:
        o.mcpServers && Object.keys(o.mcpServers).length > 0
          ? (o.mcpServers as Record<string, { command: string }>)
          : undefined,
      credentials: o.credentials,
      claudeCompatibleProvider: o.claudeCompatibleProvider,
      sdkSessionId: o.sdkSessionId,
    };
  }

  private async executeSingleAgentContinuation(
    options: AgentExecutionOptions,
    planContent: string,
    userFeedback: string | undefined,
    initialResponseText: string,
    eventLogWriter?: EventLogWriter
  ): Promise<{ responseText: string }> {
    const { featureId, projectPath, branchName = null, provider } = options;
    const providerName = provider.getName();
    logger.info(`No parsed tasks, using single-agent execution for feature ${featureId}`);
    const prompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    const contPrompt = prompts.taskExecution.continuationAfterApprovalTemplate
      .replace(/\{\{userFeedback\}\}/g, userFeedback || '')
      .replace(/\{\{approvedPlan\}\}/g, planContent);
    let responseText = initialResponseText;
    const contNormStream = new NormalizedEventStream({ provider: providerName, featureId });
    try {
      for await (const msg of superviseQuery(
        provider,
        this.buildExecOpts(options, contPrompt, options.sdkOptions?.maxTurns ?? DEFAULT_MAX_TURNS),
        DEFAULT_SUPERVISOR_POLICY
      )) {
        if (msg.session_id && msg.session_id !== options.sdkSessionId) {
          options.sdkSessionId = msg.session_id;
        }

        // Feed into the normalized event pipeline
        const normalizedEvents = contNormStream.feed(msg);
        for (const evt of normalizedEvents) {
          eventLogWriter?.append(evt);
          this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
        }

        if (msg.type === 'supervisor_status') continue; // no content, skip
        if (msg.type === 'assistant' && msg.message?.content)
          for (const b of msg.message.content) {
            if (b.type === 'text') {
              responseText += b.text || '';
              this.eventBus.emitAutoModeEvent('auto_mode_progress', {
                featureId,
                branchName,
                content: b.text,
              });
            } else if (b.type === 'tool_use')
              this.eventBus.emitAutoModeEvent('auto_mode_tool', {
                featureId,
                branchName,
                tool: b.name,
                input: b.input,
              });
          }
        else if (msg.type === 'error') {
          const cleanedError =
            (msg.error || 'Unknown error during implementation')
              .replace(/\x1b\[[0-9;]*m/g, '')
              .replace(/^Error:\s*/i, '')
              .trim() || 'Unknown error during implementation';
          throw new Error(cleanedError);
        } else if (msg.type === 'result' && msg.subtype === 'success')
          responseText += msg.result || '';
      }
    } finally {
      // Finalize the continuation's normalized stream
      const contFinalizeEvents = contNormStream.finalize();
      for (const evt of contFinalizeEvents) {
        eventLogWriter?.append(evt);
        this.eventBus.emit('feature:event', { featureId, projectPath, event: evt });
      }
    }
    return { responseText };
  }
}
