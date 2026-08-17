import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import type {
  FeatureExecutionMode,
  FeatureOrchestrationConfig,
  ModelAssignmentCandidate,
  OrchestrationModelAssignment,
  PhaseModelEntry,
} from '@aboardai/types';
import {
  getOrchestrationModelScore,
  selectOrchestrationRoles,
  toOrchestrationModelAssignment,
} from '@aboardai/model-resolver';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { getHttpApiClient } from '@/lib/http-api-client';
import { PhaseModelSelector } from '@/components/views/settings-view/model-defaults/phase-model-selector';
import { useFeatureModelCatalog } from '@/components/views/settings-view/model-defaults/use-feature-model-catalog';

interface OrchestrationModeControlProps {
  projectPath?: string;
  executionMode: FeatureExecutionMode;
  orchestration?: FeatureOrchestrationConfig;
  onExecutionModeChange: (mode: FeatureExecutionMode) => void;
  onOrchestrationChange: (config: FeatureOrchestrationConfig | undefined) => void;
  onVerificationChange?: (verified: boolean) => void;
  testIdPrefix: string;
}

const ROLE_LABELS = {
  lead: 'Lead orchestrator',
  workhorse: 'Workhorse',
  reviewer: 'Independent reviewer',
} as const;

function assignmentCandidate(
  assignment: OrchestrationModelAssignment,
  role: string
): ModelAssignmentCandidate {
  return {
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
  };
}

export function OrchestrationModeControl({
  projectPath,
  executionMode,
  orchestration,
  onExecutionModeChange,
  onOrchestrationChange,
  onVerificationChange,
  testIdPrefix,
}: OrchestrationModeControlProps) {
  const { candidates, isLoading } = useFeatureModelCatalog();
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orchestrationCandidates = useMemo(
    () =>
      candidates.filter((candidate) =>
        ['claude', 'codex', 'cursor'].includes(candidate.providerKey)
      ),
    [candidates]
  );

  const createAutomaticConfig = (): FeatureOrchestrationConfig => {
    const selected = selectOrchestrationRoles(orchestrationCandidates);
    return {
      enabled: true,
      selectionMode: 'automatic',
      lead: toOrchestrationModelAssignment(selected.lead),
      workhorse: toOrchestrationModelAssignment(selected.workhorse),
      reviewer: toOrchestrationModelAssignment(selected.reviewer),
      maxReviewRounds: 5,
    };
  };

  useEffect(() => {
    if (
      executionMode === 'orchestrated' &&
      orchestrationCandidates.length > 0 &&
      (!orchestration?.lead || !orchestration.workhorse || !orchestration.reviewer)
    ) {
      try {
        onOrchestrationChange(createAutomaticConfig());
        setError(null);
      } catch (selectionError) {
        setError(
          selectionError instanceof Error ? selectionError.message : 'No valid role spread found'
        );
      }
    }
  }, [
    executionMode,
    orchestrationCandidates,
    orchestration?.lead,
    orchestration?.reviewer,
    orchestration?.workhorse,
  ]);

  const invalidate = () => {
    setVerified(false);
    setError(null);
    onVerificationChange?.(false);
  };

  const setMode = (mode: FeatureExecutionMode) => {
    onExecutionModeChange(mode);
    invalidate();
    if (mode === 'orchestrated' && orchestrationCandidates.length > 0) {
      try {
        onOrchestrationChange(createAutomaticConfig());
      } catch (selectionError) {
        setError(
          selectionError instanceof Error ? selectionError.message : 'No valid role spread found'
        );
      }
    }
  };

  const updateRole = (role: 'lead' | 'workhorse' | 'reviewer', entry: PhaseModelEntry) => {
    const candidate = candidates.find(
      (item) => item.model === entry.model && item.providerId === entry.providerId
    );
    if (!candidate) {
      setError('The selected model is no longer in the enabled model catalog');
      return;
    }
    onOrchestrationChange({
      ...orchestration,
      enabled: true,
      selectionMode: 'manual',
      [role]: toOrchestrationModelAssignment({ ...candidate, ...entry }),
      maxReviewRounds: 5,
    });
    invalidate();
  };

  const verify = async () => {
    if (
      !projectPath ||
      !orchestration?.lead ||
      !orchestration.workhorse ||
      !orchestration.reviewer
    ) {
      setError('Choose all three roles before verification');
      return;
    }
    if (orchestration.lead.providerKey === orchestration.reviewer.providerKey) {
      setError('Lead and reviewer must use different providers');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const configuredRoleCandidates = [
        assignmentCandidate(orchestration.lead, 'lead'),
        assignmentCandidate(orchestration.workhorse, 'workhorse'),
        assignmentCandidate(orchestration.reviewer, 'reviewer'),
      ];
      const probeCandidates =
        orchestration.selectionMode === 'automatic'
          ? Array.from(
              orchestrationCandidates
                .filter((candidate) => candidate.implementationCapable !== false)
                .reduce((groups, candidate) => {
                  const group = groups.get(candidate.providerKey) ?? [];
                  group.push(candidate);
                  groups.set(candidate.providerKey, group);
                  return groups;
                }, new Map<string, ModelAssignmentCandidate[]>())
                .values()
            ).flatMap((group) => {
              const sorted = [...group].sort(
                (left, right) =>
                  getOrchestrationModelScore(right) - getOrchestrationModelScore(left)
              );
              const lowerTier = sorted.find(
                (candidate) => getOrchestrationModelScore(candidate) < 450
              );
              return [
                ...new Map(
                  [...sorted.slice(0, 2), ...(lowerTier ? [lowerTier] : [])].map((item) => [
                    item.key,
                    item,
                  ])
                ).values(),
              ];
            })
          : configuredRoleCandidates;
      const response = await getHttpApiClient().model.verifyAccess(projectPath, probeCandidates);
      const failed = response.results.filter((result) => result.status !== 'verified');
      if (orchestration.selectionMode === 'manual' && failed.length > 0) {
        throw new Error(failed.map((result) => result.error ?? result.key).join('; '));
      }
      if (orchestration.selectionMode === 'automatic') {
        const verifiedKeys = new Set(
          response.results
            .filter((result) => result.status === 'verified')
            .map((result) => result.key)
        );
        const selected = selectOrchestrationRoles(
          probeCandidates.filter((candidate) => verifiedKeys.has(candidate.key))
        );
        onOrchestrationChange({
          enabled: true,
          selectionMode: 'automatic',
          lead: toOrchestrationModelAssignment(selected.lead),
          workhorse: toOrchestrationModelAssignment(selected.workhorse),
          reviewer: toOrchestrationModelAssignment(selected.reviewer),
          maxReviewRounds: 5,
        });
      }
      setVerified(true);
      onVerificationChange?.(true);
    } catch (verificationError) {
      setVerified(false);
      onVerificationChange?.(false);
      setError(
        verificationError instanceof Error ? verificationError.message : 'Role verification failed'
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-3" data-testid={`${testIdPrefix}-orchestration-control`}>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Execution mode">
        <button
          type="button"
          className={cn(
            'rounded-lg border px-3 py-2 text-left transition-colors',
            executionMode === 'single'
              ? 'border-brand-500/60 bg-brand-500/10'
              : 'border-border bg-muted/20'
          )}
          onClick={() => setMode('single')}
          data-testid={`${testIdPrefix}-single-mode`}
        >
          <span className="block text-xs font-medium">Single model</span>
          <span className="block text-[11px] text-muted-foreground">Current behavior</span>
        </button>
        <button
          type="button"
          className={cn(
            'rounded-lg border px-3 py-2 text-left transition-colors',
            executionMode === 'orchestrated'
              ? 'border-brand-500/60 bg-brand-500/10'
              : 'border-border bg-muted/20'
          )}
          onClick={() => setMode('orchestrated')}
          data-testid={`${testIdPrefix}-orchestrated-mode`}
        >
          <span className="flex items-center gap-1 text-xs font-medium">
            <Sparkles className="h-3 w-3" /> Orchestrated
          </span>
          <span className="block text-[11px] text-muted-foreground">Plan, build, review</span>
        </button>
      </div>

      {executionMode === 'orchestrated' && (
        <div className="space-y-3 rounded-xl border border-brand-500/25 bg-brand-500/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Bot className="h-3.5 w-3.5 text-brand-500" /> Automated orchestration
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Reviewer approval gates completion. Rejections return to the lead for up to 5
                rounds.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={verifying || isLoading || !projectPath}
              onClick={verify}
              data-testid={`${testIdPrefix}-verify-orchestration`}
            >
              {verifying ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : verified ? (
                <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-green-500" />
              ) : (
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              )}
              {verified ? 'Verified' : 'Verify roles'}
            </Button>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {(['lead', 'workhorse', 'reviewer'] as const).map((role) => {
              const assignment = orchestration?.[role];
              return (
                <div
                  key={role}
                  className="space-y-1.5 rounded-lg border border-border bg-background/70 p-2"
                >
                  <Label className="text-[11px] text-muted-foreground">{ROLE_LABELS[role]}</Label>
                  {orchestration?.selectionMode === 'manual' ? (
                    <PhaseModelSelector
                      value={assignment ?? { model: '' }}
                      onChange={(entry) => updateRole(role, entry)}
                      compact
                      align="end"
                    />
                  ) : (
                    <div
                      className="truncate text-xs font-medium"
                      title={assignment?.displayName ?? assignment?.model}
                    >
                      {assignment?.displayName ?? assignment?.model ?? 'Selecting…'}
                    </div>
                  )}
                  <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                    {assignment?.providerKey ?? 'Unavailable'}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="text-[11px] text-brand-500 hover:underline"
            onClick={() => {
              invalidate();
              if (orchestration?.selectionMode === 'manual') {
                try {
                  onOrchestrationChange(createAutomaticConfig());
                } catch (selectionError) {
                  setError(
                    selectionError instanceof Error
                      ? selectionError.message
                      : 'No valid role spread found'
                  );
                }
              } else {
                onOrchestrationChange({
                  ...orchestration,
                  enabled: true,
                  selectionMode: 'manual',
                  maxReviewRounds: 5,
                });
              }
            }}
          >
            {orchestration?.selectionMode === 'manual'
              ? 'Use automatic role selection'
              : 'Choose role models manually'}
          </button>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
