import type {
  Feature,
  ModelAccessVerificationResult,
  OrchestrationModelAssignment,
  OrchestrationReviewRecord,
  OrchestrationRunRecord,
  OrchestrationVerdict,
} from '@aboardai/types';

export type OrchestrationQueryRole = 'lead-plan' | 'lead-revision' | 'reviewer';

export interface OrchestrationServiceDependencies {
  verifyAssignments: (
    assignments: readonly OrchestrationModelAssignment[]
  ) => Promise<void | ModelAccessVerificationResult[]>;
  queryRole: (
    role: OrchestrationQueryRole,
    assignment: OrchestrationModelAssignment,
    prompt: string
  ) => Promise<string>;
  runWorkhorse: (assignment: OrchestrationModelAssignment, prompt: string) => Promise<void>;
  runPipeline: (assignment: OrchestrationModelAssignment) => Promise<void>;
  collectEvidence: () => Promise<string>;
  finalizeApproved?: () => Promise<void>;
  writeArtifact: (filename: string, content: string) => Promise<void>;
  saveRun: (record: OrchestrationRunRecord) => Promise<void>;
  now?: () => string;
}

export interface OrchestrationExecutionInput {
  feature: Feature;
  basePrompt: string;
}

export interface OrchestrationExecutionResult {
  approved: boolean;
  run: OrchestrationRunRecord;
}

interface ParsedReview {
  verdict: OrchestrationVerdict;
  summary: string;
  findings: string[];
}

function parseReviewerResponse(response: string): ParsedReview | null {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const objectText = fenced ?? response.match(/\{[\s\S]*\}/)?.[0];
  if (!objectText) return null;

  try {
    const parsed = JSON.parse(objectText) as Partial<ParsedReview>;
    if (parsed.verdict !== 'approve' && parsed.verdict !== 'request_changes') return null;
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) return null;
    if (!parsed.findings.every((finding) => typeof finding === 'string')) return null;
    return {
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
    };
  } catch {
    return null;
  }
}

function requireAssignments(feature: Feature): {
  lead: OrchestrationModelAssignment;
  workhorse: OrchestrationModelAssignment;
  reviewer: OrchestrationModelAssignment;
  maxReviewRounds: number;
} {
  const config = feature.orchestration;
  if (!config?.enabled || !config.lead || !config.workhorse || !config.reviewer) {
    throw new Error('Orchestration requires lead, workhorse, and reviewer assignments');
  }
  if (config.lead.providerKey === config.reviewer.providerKey) {
    throw new Error('Lead and reviewer must use different providers');
  }
  return {
    lead: config.lead,
    workhorse: config.workhorse,
    reviewer: config.reviewer,
    maxReviewRounds: Math.max(1, Math.min(config.maxReviewRounds ?? 5, 5)),
  };
}

function leadPlanPrompt(feature: Feature, basePrompt: string): string {
  return `You are the lead orchestrator for this feature. Analyze the requirements and produce a precise implementation brief for another coding agent. Identify architecture, affected areas, invariants, tests, and likely failure modes. Do not edit files.\n\n${basePrompt}\n\nFeature ID: ${feature.id}`;
}

function workhorsePrompt(basePrompt: string, brief: string): string {
  return `${basePrompt}\n\n## Lead orchestrator implementation brief\n${brief}\n\nImplement the feature completely. Follow the brief, inspect the real code, run appropriate tests, and leave the working tree ready for independent review.`;
}

function reviewerPrompt(
  feature: Feature,
  basePrompt: string,
  brief: string,
  evidence: string,
  round: number
): string {
  return `You are the independent cross-provider reviewer. Review round ${round}. Do not edit files. Compare the implementation against the feature requirements and lead brief, inspect the supplied diff/test evidence, and reject any substantive correctness, safety, regression, or missing-test issue.\n\n${basePrompt}\n\n## Lead brief\n${brief}\n\n## Implementation and test evidence\n${evidence}\n\nReturn JSON only with this exact shape: {"verdict":"approve"|"request_changes","summary":"concise assessment","findings":["specific actionable finding"]}. Approval requires no blocking findings.`;
}

function leadRevisionPrompt(
  feature: Feature,
  brief: string,
  review: ParsedReview,
  evidence: string,
  round: number
): string {
  return `You are the lead orchestrator. The independent reviewer rejected review round ${round} for feature ${feature.id}. Diagnose the root causes and produce revised, concrete implementation instructions for the workhorse. Do not edit files and do not dispute or bypass the reviewer.\n\n## Original brief\n${brief}\n\n## Reviewer summary\n${review.summary}\n\n## Blocking findings\n${review.findings.map((finding) => `- ${finding}`).join('\n')}\n\n## Current evidence\n${evidence}`;
}

export class OrchestrationService {
  constructor(private readonly dependencies: OrchestrationServiceDependencies) {}

  async execute(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { feature, basePrompt } = input;
    const { lead, workhorse, reviewer, maxReviewRounds } = requireAssignments(feature);
    const now = this.dependencies.now ?? (() => new Date().toISOString());
    const startedAt = now();
    const run: OrchestrationRunRecord = {
      version: 1,
      featureId: feature.id,
      phase: 'verifying',
      startedAt,
      updatedAt: startedAt,
      currentRound: 0,
      maxReviewRounds,
      assignments: { lead, workhorse, reviewer },
      reviews: [],
    };

    const persist = async () => {
      run.updatedAt = now();
      await this.dependencies.saveRun(run);
    };
    await persist();

    try {
      const verification = await this.dependencies.verifyAssignments([lead, workhorse, reviewer]);
      const unavailable = verification?.filter((result) => result.status !== 'verified') ?? [];
      if (unavailable.length > 0) {
        throw new Error(
          `Orchestration model access failed: ${unavailable.map((result) => result.error ?? result.key).join(', ')}`
        );
      }

      run.phase = 'planning';
      await persist();
      const brief = await this.dependencies.queryRole(
        'lead-plan',
        lead,
        leadPlanPrompt(feature, basePrompt)
      );
      if (!brief.trim())
        throw new Error('Lead orchestrator returned an empty implementation brief');
      await this.dependencies.writeArtifact('lead-brief.md', brief);

      run.phase = 'implementing';
      await persist();
      await this.dependencies.runWorkhorse(workhorse, workhorsePrompt(basePrompt, brief));
      run.phase = 'testing';
      await persist();
      await this.dependencies.runPipeline(workhorse);

      let currentBrief = brief;
      for (let round = 1; round <= maxReviewRounds; round += 1) {
        run.currentRound = round;
        run.phase = 'reviewing';
        await persist();
        const evidence = await this.dependencies.collectEvidence();
        const reviewerResponse = await this.dependencies.queryRole(
          'reviewer',
          reviewer,
          reviewerPrompt(feature, basePrompt, currentBrief, evidence, round)
        );
        await this.dependencies.writeArtifact(`round-${round}-review.md`, reviewerResponse);
        const parsed = parseReviewerResponse(reviewerResponse);
        if (!parsed) {
          run.phase = 'waiting_approval';
          run.terminalReason = 'Reviewer did not return a valid structured verdict';
          run.completedAt = now();
          await persist();
          return { approved: false, run };
        }

        const reviewRecord: OrchestrationReviewRecord = {
          round,
          verdict: parsed.verdict,
          summary: parsed.summary,
          findings: parsed.findings,
          reviewedAt: now(),
        };
        run.reviews.push(reviewRecord);
        run.finalVerdict = parsed.verdict;
        await persist();

        if (parsed.verdict === 'approve') {
          if (this.dependencies.finalizeApproved) {
            await this.dependencies.finalizeApproved();
          }
          run.phase = 'approved';
          run.completedAt = now();
          await persist();
          return { approved: true, run };
        }

        if (round === maxReviewRounds) break;

        run.phase = 'revising';
        await persist();
        currentBrief = await this.dependencies.queryRole(
          'lead-revision',
          lead,
          leadRevisionPrompt(feature, currentBrief, parsed, evidence, round)
        );
        if (!currentBrief.trim()) {
          throw new Error('Lead orchestrator returned empty revision instructions');
        }
        await this.dependencies.writeArtifact(`round-${round}-revision.md`, currentBrief);

        run.phase = 'implementing';
        await persist();
        await this.dependencies.runWorkhorse(workhorse, workhorsePrompt(basePrompt, currentBrief));
        run.phase = 'testing';
        await persist();
        await this.dependencies.runPipeline(workhorse);
      }

      run.phase = 'waiting_approval';
      run.terminalReason = `Reviewer requested changes after ${maxReviewRounds} rounds`;
      run.completedAt = now();
      await persist();
      return { approved: false, run };
    } catch (error) {
      run.phase = 'waiting_approval';
      run.terminalReason = error instanceof Error ? error.message : 'Orchestration failed';
      run.completedAt = now();
      await persist();
      return { approved: false, run };
    }
  }
}
