/**
 * ExecutionService - Feature execution lifecycle coordination
 */

import path from 'path';
import type {
  Feature,
  ModelAssignmentCandidate,
  OrchestrationModelAssignment,
  OrchestrationRunRecord,
} from '@aboardai/types';
import { createLogger, classifyError, loadContextFiles, recordMemoryUsage } from '@aboardai/utils';
import { resolveModelString, DEFAULT_MODELS } from '@aboardai/model-resolver';
import { getGitRepositoryDiffs } from '@aboardai/git-utils';
import { getFeatureDir } from '@aboardai/platform';
import { ProviderFactory } from '../providers/provider-factory.js';
import * as secureFs from '../lib/secure-fs.js';
import {
  getPromptCustomization,
  getAutoLoadClaudeMdSetting,
  getUseClaudeCodeSystemPromptSetting,
  filterClaudeMdFromContext,
  resolveProviderContext,
} from '../lib/settings-helpers.js';
import { validateWorkingDirectory } from '../lib/sdk-options.js';
import { extractSummary } from './spec-parser.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { ConcurrencyManager, RunningFeature } from './concurrency-manager.js';
import type { WorktreeResolver } from './worktree-resolver.js';
import type { SettingsService } from './settings-service.js';
import { pipelineService } from './pipeline-service.js';
import { verifyModelAccess } from './model-access-verifier.js';
import { simpleQuery } from '../providers/simple-query-service.js';
import { OrchestrationService, type OrchestrationQueryRole } from './orchestration-service.js';
import { normalizeFeatureWorktreeAssignment } from './feature-worktree-assignment.js';
import { workspaceLeaseManager } from './workspace-lease-manager.js';

// Re-export callback types from execution-types.ts for backward compatibility
export type {
  RunAgentFn,
  ExecutePipelineFn,
  UpdateFeatureStatusFn,
  LoadFeatureFn,
  GetPlanningPromptPrefixFn,
  SaveFeatureSummaryFn,
  RecordLearningsFn,
  ContextExistsFn,
  ResumeFeatureFn,
  TrackFailureFn,
  SignalPauseFn,
  RecordSuccessFn,
  SaveExecutionStateFn,
  LoadContextFilesFn,
  FinalizePipelineFn,
  PersistWorktreeAssignmentFn,
  EnsureFeatureWorktreeFn,
  ExecutionWorktreeDependencies,
} from './execution-types.js';

import type {
  RunAgentFn,
  ExecutePipelineFn,
  UpdateFeatureStatusFn,
  LoadFeatureFn,
  GetPlanningPromptPrefixFn,
  SaveFeatureSummaryFn,
  RecordLearningsFn,
  ContextExistsFn,
  ResumeFeatureFn,
  TrackFailureFn,
  SignalPauseFn,
  RecordSuccessFn,
  SaveExecutionStateFn,
  LoadContextFilesFn,
  FinalizePipelineFn,
  ExecutionWorktreeDependencies,
} from './execution-types.js';

const logger = createLogger('ExecutionService');

/** Marker written by agent-executor for each tool invocation. */
const TOOL_USE_MARKER = '🔧 Tool:';

/** Minimum trimmed output length to consider agent work meaningful. */
const MIN_MEANINGFUL_OUTPUT_LENGTH = 200;

export class ExecutionService {
  constructor(
    private eventBus: TypedEventBus,
    private concurrencyManager: ConcurrencyManager,
    private worktreeResolver: WorktreeResolver,
    private settingsService: SettingsService | null,
    // Callback dependencies for delegation
    private runAgentFn: RunAgentFn,
    private executePipelineFn: ExecutePipelineFn,
    private updateFeatureStatusFn: UpdateFeatureStatusFn,
    private loadFeatureFn: LoadFeatureFn,
    private getPlanningPromptPrefixFn: GetPlanningPromptPrefixFn,
    private saveFeatureSummaryFn: SaveFeatureSummaryFn,
    private recordLearningsFn: RecordLearningsFn,
    private contextExistsFn: ContextExistsFn,
    private resumeFeatureFn: ResumeFeatureFn,
    private trackFailureFn: TrackFailureFn,
    private signalPauseFn: SignalPauseFn,
    private recordSuccessFn: RecordSuccessFn,
    private saveExecutionStateFn: SaveExecutionStateFn,
    private loadContextFilesFn: LoadContextFilesFn,
    private finalizePipelineFn?: FinalizePipelineFn,
    private worktreeDependencies: ExecutionWorktreeDependencies = {}
  ) {}

  private async executeOrchestratedFeature(options: {
    projectPath: string;
    feature: Feature;
    workDir: string;
    worktreePath: string | null;
    abortController: AbortController;
    basePrompt: string;
    systemPrompt?: string;
    autoLoadClaudeMd: boolean;
    useClaudeCodeSystemPrompt: boolean;
  }): Promise<{ approved: boolean; failed: boolean; reason?: string; reviewerModel?: string }> {
    const {
      projectPath,
      feature,
      workDir,
      worktreePath,
      abortController,
      basePrompt,
      systemPrompt,
      autoLoadClaudeMd,
      useClaudeCodeSystemPrompt,
    } = options;
    const orchestrationDir = path.join(getFeatureDir(projectPath, feature.id), 'orchestration');
    await secureFs.mkdir(orchestrationDir, { recursive: true });

    const toCandidate = (
      assignment: OrchestrationModelAssignment,
      role: string
    ): ModelAssignmentCandidate => ({
      key: assignment.candidateKey ?? `${role}:${assignment.providerKey}:${assignment.model}`,
      model: assignment.model,
      displayName: assignment.displayName ?? assignment.model,
      providerKey: assignment.providerKey,
      providerLabel: assignment.providerKey,
      providerId: assignment.providerId,
      thinkingLevel: assignment.thinkingLevel,
      reasoningEffort: assignment.reasoningEffort,
      isProviderDefault: false,
      implementationCapable: true,
    });

    const queryRole = async (
      _role: OrchestrationQueryRole,
      assignment: OrchestrationModelAssignment,
      prompt: string
    ): Promise<string> => {
      if (!this.settingsService) throw new Error('Settings service is unavailable');
      const resolvedModel = resolveModelString(assignment.model, DEFAULT_MODELS.claude);
      const providerContext = await resolveProviderContext(
        this.settingsService,
        resolvedModel,
        assignment.providerId,
        '[OrchestrationService]'
      );
      const result = await simpleQuery({
        prompt,
        model: providerContext.resolvedModel ?? resolvedModel,
        cwd: workDir,
        maxTurns: 1,
        allowedTools: [],
        readOnly: true,
        settingSources: [],
        abortController,
        thinkingLevel: assignment.thinkingLevel,
        reasoningEffort: assignment.reasoningEffort,
        claudeCompatibleProvider: providerContext.provider,
        credentials: providerContext.credentials,
      });
      return result.text;
    };

    const getPipelineContext = async (assignment: OrchestrationModelAssignment) => {
      const pipelineConfig = await pipelineService.getPipelineConfig(projectPath);
      const excludedStepIds = new Set(feature.excludedPipelineSteps || []);
      const steps = [...(pipelineConfig?.steps || [])]
        .sort((left, right) => left.order - right.order)
        .filter((step) => !excludedStepIds.has(step.id));
      return {
        projectPath,
        featureId: feature.id,
        feature: {
          ...feature,
          model: assignment.model,
          providerId: assignment.providerId,
          thinkingLevel: assignment.thinkingLevel,
          reasoningEffort: assignment.reasoningEffort,
        },
        steps,
        workDir,
        worktreePath,
        branchName: feature.branchName ?? null,
        abortController,
        autoLoadClaudeMd,
        useClaudeCodeSystemPrompt,
        testAttempts: 0,
        maxTestAttempts: 5,
        deferMerge: true,
      };
    };

    const service = new OrchestrationService({
      verifyAssignments: async (assignments) => {
        if (!this.settingsService) throw new Error('Settings service is unavailable');
        const candidates = assignments.map((assignment, index) =>
          toCandidate(assignment, ['lead', 'workhorse', 'reviewer'][index] ?? `role-${index}`)
        );
        const results = await verifyModelAccess(candidates, projectPath, this.settingsService);
        // CLI providers cold-starting on Windows regularly blow the default
        // 20s probe timeout while auto mode saturates the machine. Retry
        // timeouts once with a bigger budget; if a probe still times out,
        // let the run proceed — the real query will surface a real error.
        // Auth/billing failures stay fatal.
        const timedOut = results
          .map((result, index) => (result.error === 'Verification timed out' ? index : -1))
          .filter((index) => index >= 0);
        if (timedOut.length > 0) {
          const retried = await verifyModelAccess(
            timedOut.map((index) => candidates[index]),
            projectPath,
            this.settingsService,
            { timeoutMs: 60_000, concurrency: 1 }
          );
          retried.forEach((result, j) => {
            results[timedOut[j]] = result;
          });
        }
        return results.map((result) => {
          if (result.error === 'Verification timed out') {
            logger.warn(
              `Model access probe for ${result.key} timed out twice; proceeding unverified`
            );
            return { ...result, status: 'verified' as const, error: undefined };
          }
          return result;
        });
      },
      queryRole,
      runWorkhorse: async (assignment, prompt) => {
        await this.runAgentFn(
          workDir,
          feature.id,
          prompt,
          abortController,
          projectPath,
          feature.imagePaths?.map((image) => (typeof image === 'string' ? image : image.path)),
          assignment.model,
          {
            projectPath,
            planningMode: 'skip',
            requirePlanApproval: false,
            systemPrompt,
            autoLoadClaudeMd,
            useClaudeCodeSystemPrompt,
            thinkingLevel: assignment.thinkingLevel,
            reasoningEffort: assignment.reasoningEffort,
            providerId: assignment.providerId,
            branchName: feature.branchName ?? null,
          }
        );
      },
      runPipeline: async (assignment) => {
        const context = await getPipelineContext(assignment);
        if (context.steps.length > 0) await this.executePipelineFn(context);
      },
      collectEvidence: async () => {
        const repository = await getGitRepositoryDiffs(workDir);
        let agentOutput = '';
        try {
          agentOutput = (await secureFs.readFile(
            path.join(getFeatureDir(projectPath, feature.id), 'agent-output.md'),
            'utf-8'
          )) as string;
        } catch {
          // Review can proceed from the repository diff alone.
        }
        const evidence = `## Git diff\n${repository.diff || '(no diff detected)'}\n\n## Workhorse and pipeline output\n${agentOutput || '(no output captured)'}`;
        return evidence.slice(-120_000);
      },
      writeArtifact: (filename, content) =>
        secureFs.writeFile(path.join(orchestrationDir, filename), content, 'utf-8'),
      saveRun: (run: OrchestrationRunRecord) =>
        secureFs.writeFile(
          path.join(orchestrationDir, 'run.json'),
          JSON.stringify(run, null, 2),
          'utf-8'
        ),
      finalizeApproved: async () => {
        if (!feature.branchName || !this.finalizePipelineFn) return;
        const workhorse = feature.orchestration?.workhorse;
        if (!workhorse) throw new Error('Workhorse assignment is unavailable during merge');
        const context = await getPipelineContext(workhorse);
        const result = await this.finalizePipelineFn({ ...context, deferMerge: false });
        if (!result.success) {
          throw new Error(result.error ?? 'Approved work could not be merged');
        }
      },
    });

    const result = await service.execute({ feature, basePrompt });
    return {
      approved: result.approved,
      failed: result.failed,
      reason: result.run.terminalReason,
      reviewerModel: result.run.assignments.reviewer.model,
    };
  }

  private acquireRunningFeature(options: {
    featureId: string;
    projectPath: string;
    isAutoMode: boolean;
    allowReuse?: boolean;
  }): RunningFeature {
    return this.concurrencyManager.acquire(options);
  }

  private releaseRunningFeature(featureId: string, options?: { force?: boolean }): void {
    this.concurrencyManager.release(featureId, options);
  }

  private extractTitleFromDescription(description: string | undefined): string {
    if (!description?.trim()) return 'Untitled Feature';
    const firstLine = description.split('\n')[0].trim();
    return firstLine.length <= 60 ? firstLine : firstLine.substring(0, 57) + '...';
  }

  /**
   * Build feature description section (without implementation instructions).
   * Used when planning mode is active — the planning prompt provides its own instructions.
   */
  buildFeatureDescription(feature: Feature): string {
    const title = this.extractTitleFromDescription(feature.description);

    let prompt = `## Feature Task

**Feature ID:** ${feature.id}
**Title:** ${title}
**Description:** ${feature.description}
`;

    if (feature.spec) {
      prompt += `
**Specification:**
${feature.spec}
`;
    }

    if (feature.imagePaths && feature.imagePaths.length > 0) {
      const imagesList = feature.imagePaths
        .map((img, idx) => {
          const imgPath = typeof img === 'string' ? img : img.path;
          const filename =
            typeof img === 'string'
              ? imgPath.split('/').pop()
              : img.filename || imgPath.split('/').pop();
          const mimeType = typeof img === 'string' ? 'image/*' : img.mimeType || 'image/*';
          return `   ${idx + 1}. ${filename} (${mimeType})\n      Path: ${imgPath}`;
        })
        .join('\n');
      prompt += `\n**Context Images Attached:**\n${feature.imagePaths.length} image(s) attached:\n${imagesList}\n`;
    }

    return prompt;
  }

  buildFeaturePrompt(
    feature: Feature,
    taskExecutionPrompts: {
      implementationInstructions: string;
      playwrightVerificationInstructions: string;
    }
  ): string {
    let prompt = this.buildFeatureDescription(feature);

    prompt += feature.skipTests
      ? `\n${taskExecutionPrompts.implementationInstructions}`
      : `\n${taskExecutionPrompts.implementationInstructions}\n\n${taskExecutionPrompts.playwrightVerificationInstructions}`;
    return prompt;
  }

  async executeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = false,
    isAutoMode = false,
    providedWorktreePath?: string,
    options?: { continuationPrompt?: string; _calledInternally?: boolean }
  ): Promise<void> {
    const tempRunningFeature = this.acquireRunningFeature({
      featureId,
      projectPath,
      isAutoMode,
      allowReuse: options?._calledInternally,
    });
    const abortController = tempRunningFeature.abortController;
    if (isAutoMode) await this.saveExecutionStateFn(projectPath);
    let feature: Feature | null = null;
    let pipelineCompleted = false;
    let releaseWorkspaceLease: (() => void) | undefined;

    try {
      validateWorkingDirectory(projectPath);
      feature = await this.loadFeatureFn(projectPath, featureId);
      if (!feature) throw new Error(`Feature ${featureId} not found`);

      const primaryBranch = (await this.worktreeResolver.getCurrentBranch(projectPath)) ?? 'main';
      const assignment = normalizeFeatureWorktreeAssignment(feature, primaryBranch);
      const assignmentChanged =
        feature.worktreeMode !== assignment.worktreeMode ||
        feature.branchName !== assignment.branchName ||
        feature.worktreeBaseBranch !== assignment.worktreeBaseBranch;
      if (assignmentChanged) {
        feature = this.worktreeDependencies.persistWorktreeAssignmentFn
          ? await this.worktreeDependencies.persistWorktreeAssignmentFn(
              projectPath,
              featureId,
              assignment
            )
          : { ...feature, ...assignment };
      }

      let worktreePath: string | null = providedWorktreePath ?? null;
      const branchName = feature.branchName;
      if (!worktreePath && useWorktrees && feature.worktreeMode === 'isolated' && branchName) {
        if (this.worktreeDependencies.ensureFeatureWorktreeFn) {
          worktreePath = await this.worktreeDependencies.ensureFeatureWorktreeFn(
            projectPath,
            branchName,
            feature.worktreeBaseBranch ?? primaryBranch
          );
        } else {
          worktreePath = await this.worktreeResolver.findWorktreeForBranch(projectPath, branchName);
          if (!worktreePath) {
            throw new Error(
              `Worktree enabled but no worktree found for feature branch "${branchName}".`
            );
          }
        }
      } else if (
        !worktreePath &&
        useWorktrees &&
        feature.worktreeMode === 'shared' &&
        branchName &&
        branchName !== primaryBranch
      ) {
        worktreePath = await this.worktreeResolver.findWorktreeForBranch(projectPath, branchName);
        if (!worktreePath) {
          throw new Error(
            `Worktree enabled but no worktree found for feature branch "${branchName}".`
          );
        }
      }
      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);
      validateWorkingDirectory(workDir);
      releaseWorkspaceLease = await (
        this.worktreeDependencies.workspaceLeaseManager ?? workspaceLeaseManager
      ).acquire(workDir, featureId, abortController.signal);
      tempRunningFeature.worktreePath = worktreePath;
      tempRunningFeature.branchName = branchName ?? null;
      if (worktreePath) {
        logger.info(`Using worktree for branch "${branchName}": ${worktreePath}`);
      }

      // Update status to in_progress immediately after acquiring the feature.
      // This prevents a race condition where the UI reloads features and sees the
      // feature still in 'backlog' status while it's actually being executed.
      // Only do this for the initial call (not internal/recursive calls which would
      // redundantly update the status).
      if (
        !options?._calledInternally &&
        (feature.status === 'backlog' ||
          feature.status === 'ready' ||
          feature.status === 'interrupted')
      ) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');
      }

      if (!options?.continuationPrompt) {
        if (feature.planSpec?.status === 'approved') {
          const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');
          let continuationPrompt = prompts.taskExecution.continuationAfterApprovalTemplate;
          continuationPrompt = continuationPrompt
            .replace(/\{\{userFeedback\}\}/g, '')
            .replace(/\{\{approvedPlan\}\}/g, feature.planSpec.content || '');
          return await this.executeFeature(
            projectPath,
            featureId,
            useWorktrees,
            isAutoMode,
            providedWorktreePath,
            { continuationPrompt, _calledInternally: true }
          );
        }
        if (await this.contextExistsFn(projectPath, featureId)) {
          return await this.resumeFeatureFn(projectPath, featureId, useWorktrees, true);
        }
      }

      // Ensure status is in_progress (may already be set from the early update above,
      // but internal/recursive calls skip the early update and need it here).
      // Mirror the external guard: only transition when the feature is still in
      // backlog, ready, or interrupted to avoid overwriting a concurrent terminal status.
      if (
        options?._calledInternally &&
        (feature.status === 'backlog' ||
          feature.status === 'ready' ||
          feature.status === 'interrupted')
      ) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'in_progress');
      }
      this.eventBus.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        branchName: feature.branchName ?? null,
        feature: {
          id: featureId,
          title: feature.title || 'Loading...',
          description: feature.description || 'Feature is starting',
        },
      });

      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[ExecutionService]'
      );
      const useClaudeCodeSystemPrompt = await getUseClaudeCodeSystemPromptSetting(
        projectPath,
        this.settingsService,
        '[ExecutionService]'
      );
      const prompts = await getPromptCustomization(this.settingsService, '[ExecutionService]');
      let prompt: string;
      const contextResult = await this.loadContextFilesFn({
        projectPath,
        fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
        taskContext: {
          title: feature.title ?? '',
          description: feature.description ?? '',
        },
      });
      const combinedSystemPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);
      const isOrchestrated =
        feature.executionMode === 'orchestrated' && feature.orchestration?.enabled === true;

      if (options?.continuationPrompt) {
        prompt = options.continuationPrompt;
      } else if (isOrchestrated) {
        // The lead orchestrator owns planning in orchestrated mode. Avoid mixing the
        // legacy single-agent planning prompt into the role-separated workflow.
        prompt = this.buildFeaturePrompt(feature, prompts.taskExecution);
      } else {
        const planningPrefix = await this.getPlanningPromptPrefixFn(feature);
        if (planningPrefix) {
          // Planning mode active: use planning instructions + feature description only.
          // Do NOT include implementationInstructions — they conflict with the planning
          // prompt's "DO NOT proceed with implementation until approval" directive.
          prompt = planningPrefix + '\n\n' + this.buildFeatureDescription(feature);
        } else {
          prompt = this.buildFeaturePrompt(feature, prompts.taskExecution);
        }
        if (feature.planningMode && feature.planningMode !== 'skip') {
          this.eventBus.emitAutoModeEvent('planning_started', {
            featureId: feature.id,
            mode: feature.planningMode,
            message: `Starting ${feature.planningMode} planning phase`,
          });
        }
      }

      if (isOrchestrated && !options?.continuationPrompt) {
        const orchestrationResult = await this.executeOrchestratedFeature({
          projectPath,
          feature,
          workDir,
          worktreePath,
          abortController,
          basePrompt: prompt,
          systemPrompt: combinedSystemPrompt || undefined,
          autoLoadClaudeMd,
          useClaudeCodeSystemPrompt,
        });
        if (orchestrationResult.failed) {
          throw new Error(orchestrationResult.reason || 'Orchestration failed');
        }
        pipelineCompleted = true;
        const currentFeature = await this.loadFeatureFn(projectPath, featureId);
        if (currentFeature?.status !== 'merge_conflict') {
          await this.updateFeatureStatusFn(
            projectPath,
            featureId,
            orchestrationResult.approved ? 'verified' : 'waiting_approval'
          );
        }
        if (orchestrationResult.approved) this.recordSuccessFn();

        if (isAutoMode) {
          this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
            featureId,
            featureName: feature.title,
            branchName: feature.branchName ?? null,
            executionMode: 'auto',
            passes: orchestrationResult.approved,
            message: orchestrationResult.approved
              ? `Independent review approved by ${orchestrationResult.reviewerModel}`
              : orchestrationResult.reason || 'Orchestration requires human approval',
            projectPath,
            model: feature.orchestration?.lead?.model,
            provider: feature.orchestration?.lead?.providerKey,
          });
        }
        return;
      }

      const imagePaths = feature.imagePaths?.map((img) =>
        typeof img === 'string' ? img : img.path
      );
      const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);
      tempRunningFeature.model = model;
      tempRunningFeature.provider = ProviderFactory.getProviderNameForModel(model);

      await this.runAgentFn(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        imagePaths,
        model,
        {
          projectPath,
          planningMode: feature.planningMode,
          requirePlanApproval: feature.requirePlanApproval,
          systemPrompt: combinedSystemPrompt || undefined,
          autoLoadClaudeMd,
          useClaudeCodeSystemPrompt,
          thinkingLevel: feature.thinkingLevel,
          reasoningEffort: feature.reasoningEffort,
          providerId: feature.providerId,
          branchName: feature.branchName ?? null,
        }
      );

      // Check for incomplete tasks after agent execution.
      // The agent may have finished early (hit max turns, decided it was done, etc.)
      // while tasks are still pending. If so, re-run the agent to complete remaining tasks.
      const MAX_TASK_RETRY_ATTEMPTS = 3;
      let taskRetryAttempts = 0;
      while (!abortController.signal.aborted && taskRetryAttempts < MAX_TASK_RETRY_ATTEMPTS) {
        const currentFeature = await this.loadFeatureFn(projectPath, featureId);
        if (!currentFeature?.planSpec?.tasks) break;

        const pendingTasks = currentFeature.planSpec.tasks.filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        );
        if (pendingTasks.length === 0) break;

        taskRetryAttempts++;
        const totalTasks = currentFeature.planSpec.tasks.length;
        const completedTasks = currentFeature.planSpec.tasks.filter(
          (t) => t.status === 'completed'
        ).length;
        logger.info(
          `[executeFeature] Feature ${featureId} has ${pendingTasks.length} incomplete tasks (${completedTasks}/${totalTasks} completed). Re-running agent (attempt ${taskRetryAttempts}/${MAX_TASK_RETRY_ATTEMPTS})`
        );

        this.eventBus.emitAutoModeEvent('auto_mode_progress', {
          featureId,
          branchName: feature.branchName ?? null,
          content: `Agent finished with ${pendingTasks.length} tasks remaining. Re-running to complete tasks (attempt ${taskRetryAttempts}/${MAX_TASK_RETRY_ATTEMPTS})...`,
          projectPath,
        });

        // Build a continuation prompt that tells the agent to finish remaining tasks
        const remainingTasksList = pendingTasks
          .map((t) => `- ${t.id}: ${t.description} (${t.status})`)
          .join('\n');

        const continuationPrompt = `## Continue Implementation - Incomplete Tasks

The previous agent session ended before all tasks were completed. Please continue implementing the remaining tasks.

**Completed:** ${completedTasks}/${totalTasks} tasks
**Remaining tasks:**
${remainingTasksList}

Please continue from where you left off and complete all remaining tasks. Use the same [TASK_START:ID] and [TASK_COMPLETE:ID] markers for each task.`;

        await this.runAgentFn(
          workDir,
          featureId,
          continuationPrompt,
          abortController,
          projectPath,
          undefined,
          model,
          {
            projectPath,
            planningMode: 'skip',
            requirePlanApproval: false,
            systemPrompt: combinedSystemPrompt || undefined,
            autoLoadClaudeMd,
            useClaudeCodeSystemPrompt,
            thinkingLevel: feature.thinkingLevel,
            reasoningEffort: feature.reasoningEffort,
            providerId: feature.providerId,
            branchName: feature.branchName ?? null,
          }
        );
      }

      // Log if tasks are still incomplete after retry attempts
      if (taskRetryAttempts >= MAX_TASK_RETRY_ATTEMPTS) {
        const finalFeature = await this.loadFeatureFn(projectPath, featureId);
        const stillPending = finalFeature?.planSpec?.tasks?.filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        );
        if (stillPending && stillPending.length > 0) {
          logger.warn(
            `[executeFeature] Feature ${featureId} still has ${stillPending.length} incomplete tasks after ${MAX_TASK_RETRY_ATTEMPTS} retry attempts. Moving to final status.`
          );
        }
      }

      const pipelineConfig = await pipelineService.getPipelineConfig(projectPath);
      const excludedStepIds = new Set(feature.excludedPipelineSteps || []);
      const sortedSteps = [...(pipelineConfig?.steps || [])]
        .sort((a, b) => a.order - b.order)
        .filter((step) => !excludedStepIds.has(step.id));
      if (sortedSteps.length > 0) {
        await this.executePipelineFn({
          projectPath,
          featureId,
          feature,
          steps: sortedSteps,
          workDir,
          worktreePath,
          branchName: feature.branchName ?? null,
          abortController,
          autoLoadClaudeMd,
          useClaudeCodeSystemPrompt,
          testAttempts: 0,
          maxTestAttempts: 5,
        });
        pipelineCompleted = true;
        // Check if pipeline set a terminal status (e.g., merge_conflict) — don't overwrite it
        const refreshed = await this.loadFeatureFn(projectPath, featureId);
        if (refreshed?.status === 'merge_conflict') {
          return;
        }
      }

      // Read agent output before determining final status.
      // CLI-based providers (Cursor, Codex, etc.) may exit quickly without doing
      // meaningful work. Check output to avoid prematurely marking as 'verified'.
      const outputPath = path.join(getFeatureDir(projectPath, featureId), 'agent-output.md');
      let agentOutput = '';
      try {
        agentOutput = (await secureFs.readFile(outputPath, 'utf-8')) as string;
      } catch {
        /* */
      }

      // Determine if the agent did meaningful work by checking for tool usage
      // indicators in the output. The agent executor writes "🔧 Tool:" markers
      // each time a tool is invoked. No tool usage suggests the CLI exited
      // without performing implementation work.
      const hasToolUsage = agentOutput.includes(TOOL_USE_MARKER);
      const isOutputTooShort = agentOutput.trim().length < MIN_MEANINGFUL_OUTPUT_LENGTH;
      const agentDidWork = hasToolUsage && !isOutputTooShort;

      let finalStatus: 'verified' | 'waiting_approval';
      if (feature.skipTests) {
        finalStatus = 'waiting_approval';
      } else if (!agentDidWork) {
        // Agent didn't produce meaningful output (e.g., CLI exited quickly).
        // Route to waiting_approval so the user can review and re-run.
        finalStatus = 'waiting_approval';
        logger.warn(
          `[executeFeature] Feature ${featureId}: agent produced insufficient output ` +
            `(${agentOutput.trim().length}/${MIN_MEANINGFUL_OUTPUT_LENGTH} chars, toolUsage=${hasToolUsage}). ` +
            `Setting status to waiting_approval instead of verified.`
        );
      } else {
        finalStatus = 'verified';
      }

      await this.updateFeatureStatusFn(projectPath, featureId, finalStatus);
      this.recordSuccessFn();

      // Check final task completion state for accurate reporting
      const completedFeature = await this.loadFeatureFn(projectPath, featureId);
      const totalTasks = completedFeature?.planSpec?.tasks?.length ?? 0;
      const completedTasks =
        completedFeature?.planSpec?.tasks?.filter((t) => t.status === 'completed').length ?? 0;
      const hasIncompleteTasks = totalTasks > 0 && completedTasks < totalTasks;

      try {
        // Only save summary if feature doesn't already have one (e.g., accumulated from pipeline steps)
        // This prevents overwriting accumulated summaries with just the last step's output
        // The agent-executor already extracts and saves summaries during execution
        if (agentOutput && !completedFeature?.summary) {
          const summary = extractSummary(agentOutput);
          if (summary) await this.saveFeatureSummaryFn(projectPath, featureId, summary);
        }
        if (contextResult.memoryFiles.length > 0 && agentOutput) {
          await recordMemoryUsage(
            projectPath,
            contextResult.memoryFiles,
            agentOutput,
            true,
            secureFs as Parameters<typeof recordMemoryUsage>[4]
          );
        }
        await this.recordLearningsFn(projectPath, feature, agentOutput);
      } catch {
        /* learnings recording failed */
      }

      const elapsedSeconds = Math.round((Date.now() - tempRunningFeature.startTime) / 1000);
      let completionMessage = `Feature completed in ${elapsedSeconds}s`;
      if (finalStatus === 'verified') completionMessage += ' - auto-verified';
      if (hasIncompleteTasks)
        completionMessage += ` (${completedTasks}/${totalTasks} tasks completed)`;

      if (isAutoMode) {
        this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          featureName: feature.title,
          branchName: feature.branchName ?? null,
          executionMode: 'auto',
          passes: true,
          message: completionMessage,
          projectPath,
          model: tempRunningFeature.model,
          provider: tempRunningFeature.provider,
        });
      }
    } catch (error) {
      const errorInfo = classifyError(error);
      if (errorInfo.isAbort) {
        await this.updateFeatureStatusFn(projectPath, featureId, 'interrupted');
        if (isAutoMode) {
          this.eventBus.emitAutoModeEvent('auto_mode_feature_complete', {
            featureId,
            featureName: feature?.title,
            branchName: feature?.branchName ?? null,
            executionMode: 'auto',
            passes: false,
            message: 'Feature stopped by user',
            projectPath,
          });
        }
      } else {
        logger.error(`Feature ${featureId} failed:`, error);
        // If pipeline steps completed successfully, don't send the feature back to backlog.
        // The pipeline work is done — set to waiting_approval so the user can review.
        const fallbackStatus = pipelineCompleted ? 'waiting_approval' : 'backlog';
        if (pipelineCompleted) {
          logger.info(
            `[executeFeature] Feature ${featureId} failed after pipeline completed. ` +
              `Setting status to waiting_approval instead of backlog to preserve pipeline work.`
          );
        }
        // Don't overwrite terminal states like 'merge_conflict' that were set during pipeline execution
        let currentStatus: string | undefined;
        try {
          const currentFeature = await this.loadFeatureFn(projectPath, featureId);
          currentStatus = currentFeature?.status;
        } catch (loadErr) {
          // If loading fails, log it and proceed with the status update anyway
          logger.warn(
            `[executeFeature] Failed to reload feature ${featureId} for status check:`,
            loadErr
          );
        }
        if (currentStatus !== 'merge_conflict') {
          await this.updateFeatureStatusFn(projectPath, featureId, fallbackStatus);
        }
        this.eventBus.emitAutoModeEvent('auto_mode_error', {
          featureId,
          featureName: feature?.title,
          branchName: feature?.branchName ?? null,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });
        if (this.trackFailureFn({ type: errorInfo.type, message: errorInfo.message })) {
          this.signalPauseFn({ type: errorInfo.type, message: errorInfo.message });
        }
      }
    } finally {
      releaseWorkspaceLease?.();
      this.releaseRunningFeature(featureId);
      if (isAutoMode && projectPath) await this.saveExecutionStateFn(projectPath);
    }
  }

  async stopFeature(featureId: string): Promise<boolean> {
    const running = this.concurrencyManager.getRunningFeature(featureId);
    if (!running) return false;
    const { projectPath } = running;

    // Immediately update feature status to 'interrupted' so the UI reflects
    // the stop right away. CLI-based providers can take seconds to terminate
    // their subprocess after the abort signal fires, leaving the feature stuck
    // in 'in_progress' on the Kanban board until the executeFeature catch block
    // eventually runs. By persisting and emitting the status change here, the
    // board updates immediately regardless of how long the subprocess takes to stop.
    try {
      await this.updateFeatureStatusFn(projectPath, featureId, 'interrupted');
    } catch (err) {
      // Non-fatal: the abort still proceeds and executeFeature's catch block
      // will attempt the same update once the subprocess terminates.
      logger.warn(`stopFeature: failed to immediately update status for ${featureId}:`, err);
    }

    running.abortController.abort();
    this.releaseRunningFeature(featureId, { force: true });
    return true;
  }
}
