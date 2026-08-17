import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import type {
  Feature,
  ModelAccessVerificationResult,
  ModelAssignmentCandidate,
  ModelDistributionAssignment,
  FeatureOrchestrationConfig,
} from '@aboardai/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { getHttpApiClient } from '@/lib/http-api-client';
import { useFeatureModelCatalog } from '@/components/views/settings-view/model-defaults/use-feature-model-catalog';
import { applyModelAssignments, type AssignmentProgress } from '../shared/bulk-model-assignment';
import { createAutomaticCandidates, distributeModels } from '../shared/model-distribution';
import { ProviderModelGroup } from './provider-model-group';
import { OrchestrationModeControl } from '../shared/orchestration-mode-control';

interface BalanceModelsDialogProps {
  open: boolean;
  projectPath: string;
  features: Feature[];
  onOpenChange: (open: boolean) => void;
  onUpdateFeature: (featureId: string, patch: Partial<Feature>) => Promise<void>;
  onComplete: (result: { succeededIds: string[]; failedIds: string[] }) => void;
}

type DistributionMode = 'automatic' | 'manual';
type AssignmentKind = 'single' | 'orchestrated';
type DialogPhase = 'setup' | 'verifying' | 'applying' | 'complete';

export function BalanceModelsDialog({
  open,
  projectPath,
  features,
  onOpenChange,
  onUpdateFeature,
  onComplete,
}: BalanceModelsDialogProps) {
  const {
    candidates,
    groups,
    setProviderEnabled,
    isLoading,
    error: catalogError,
  } = useFeatureModelCatalog();
  const [snapshot, setSnapshot] = useState<Feature[]>(features);
  const [mode, setMode] = useState<DistributionMode>('automatic');
  const [assignmentKind, setAssignmentKind] = useState<AssignmentKind>('single');
  const [bulkOrchestration, setBulkOrchestration] = useState<FeatureOrchestrationConfig>();
  const [bulkOrchestrationVerified, setBulkOrchestrationVerified] = useState(false);
  const [orchestrationFailedIds, setOrchestrationFailedIds] = useState<string[]>([]);
  const [manualKeys, setManualKeys] = useState<string[]>([]);
  const [phase, setPhase] = useState<DialogPhase>('setup');
  const [verification, setVerification] = useState<Record<string, ModelAccessVerificationResult>>(
    {}
  );
  const [operationError, setOperationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssignmentProgress>({
    completed: 0,
    total: 0,
    failed: 0,
  });
  const [failedAssignments, setFailedAssignments] = useState<ModelDistributionAssignment[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const wasOpen = useRef(false);
  const initializedGroups = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setSnapshot(features);
      setMode('automatic');
      setAssignmentKind('single');
      setBulkOrchestration(undefined);
      setBulkOrchestrationVerified(false);
      setOrchestrationFailedIds([]);
      setManualKeys([]);
      setPhase('setup');
      setVerification({});
      setOperationError(null);
      setFailedAssignments([]);
      setExpandedGroups(new Set());
      initializedGroups.current = false;
    }
    if (!open) initializedGroups.current = false;
    wasOpen.current = open;
  }, [features, open]);

  useEffect(() => {
    if (!open || initializedGroups.current || groups.length === 0) return;
    const firstEnabledGroup = groups.find((group) => group.enabled);
    setExpandedGroups(firstEnabledGroup ? new Set([firstEnabledGroup.key]) : new Set());
    initializedGroups.current = true;
  }, [groups, open]);

  const automaticCandidates = useMemo(() => createAutomaticCandidates(candidates), [candidates]);
  const selectedCandidates = useMemo(
    () =>
      mode === 'automatic'
        ? automaticCandidates
        : candidates.filter((candidate) => manualKeys.includes(candidate.key)),
    [automaticCandidates, candidates, manualKeys, mode]
  );
  const verifiedCandidates = selectedCandidates.filter(
    (candidate) => verification[candidate.key]?.status === 'verified'
  );
  const verificationComplete =
    selectedCandidates.length > 0 &&
    (mode === 'automatic'
      ? Object.keys(verification).length > 0 && verifiedCandidates.length > 0
      : selectedCandidates.every(
          (candidate) => verification[candidate.key]?.status === 'verified'
        ));
  const preview = useMemo(() => {
    if (!verificationComplete || snapshot.length === 0) return null;
    return distributeModels(
      snapshot.map((feature) => feature.id),
      verifiedCandidates
    );
  }, [snapshot, verificationComplete, verifiedCandidates]);

  const invalidateVerification = () => {
    setVerification({});
    setOperationError(null);
    setPhase('setup');
  };

  const verify = async () => {
    if (selectedCandidates.length === 0) return;
    setPhase('verifying');
    setOperationError(null);
    try {
      const response = await getHttpApiClient().model.verifyAccess(projectPath, selectedCandidates);
      setVerification(Object.fromEntries(response.results.map((result) => [result.key, result])));
      setPhase('setup');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Model verification failed');
      setPhase('setup');
    }
  };

  const apply = async (assignments: ModelDistributionAssignment[]) => {
    setPhase('applying');
    setOperationError(null);
    setProgress({ completed: 0, total: assignments.length, failed: 0 });
    const result = await applyModelAssignments(assignments, onUpdateFeature, {
      onProgress: setProgress,
    });
    const failedIds = new Set(result.failed.map((failure) => failure.featureId));
    setFailedAssignments(assignments.filter((assignment) => failedIds.has(assignment.featureId)));
    setPhase('complete');
    onComplete({
      succeededIds: result.succeededIds,
      failedIds: result.failed.map((failure) => failure.featureId),
    });
  };

  const applyOrchestration = async (targetFeatures: Feature[]) => {
    if (!bulkOrchestration || !bulkOrchestrationVerified) return;
    setPhase('applying');
    setOperationError(null);
    setProgress({ completed: 0, total: targetFeatures.length, failed: 0 });
    const succeededIds: string[] = [];
    const failedIds: string[] = [];

    await Promise.all(
      targetFeatures.map(async (feature) => {
        try {
          await onUpdateFeature(feature.id, {
            executionMode: 'orchestrated',
            orchestration: bulkOrchestration,
          });
          succeededIds.push(feature.id);
        } catch {
          failedIds.push(feature.id);
        } finally {
          setProgress((current) => ({
            completed: current.completed + 1,
            total: targetFeatures.length,
            failed: failedIds.length,
          }));
        }
      })
    );

    setFailedAssignments([]);
    setOrchestrationFailedIds(failedIds);
    setPhase('complete');
    onComplete({ succeededIds, failedIds });
  };

  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => phase !== 'applying' && onOpenChange(next)}>
      <DialogContent className="max-w-2xl" data-testid="balance-models-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-500/30 bg-brand-500/10 text-brand-500">
              <Scale className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Balance Models</DialogTitle>
              <DialogDescription>
                Verify active model access, preview the spread, then assign {snapshot.length}{' '}
                selected backlog feature{snapshot.length === 1 ? '' : 's'}.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase !== 'applying' && phase !== 'complete' && (
          <div className="space-y-4 overflow-y-auto py-3">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Assignment type">
              <Button
                type="button"
                variant={assignmentKind === 'single' ? 'default' : 'outline'}
                onClick={() => setAssignmentKind('single')}
              >
                Spread single models
              </Button>
              <Button
                type="button"
                variant={assignmentKind === 'orchestrated' ? 'default' : 'outline'}
                onClick={() => {
                  setAssignmentKind('orchestrated');
                  setBulkOrchestrationVerified(false);
                }}
              >
                Assign orchestrated teams
              </Button>
            </div>

            {assignmentKind === 'orchestrated' ? (
              <OrchestrationModeControl
                projectPath={projectPath}
                executionMode="orchestrated"
                orchestration={bulkOrchestration}
                onExecutionModeChange={() => undefined}
                onOrchestrationChange={setBulkOrchestration}
                onVerificationChange={setBulkOrchestrationVerified}
                testIdPrefix="balance-models"
              />
            ) : (
              <>
                <RadioGroup
                  aria-label="Distribution mode"
                  value={mode}
                  onValueChange={(value) => {
                    setMode(value as DistributionMode);
                    invalidateVerification();
                  }}
                  className="grid grid-cols-2 gap-2"
                >
                  {(['automatic', 'manual'] as const).map((value) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-muted/20 p-3 has-[[data-state=checked]]:border-brand-500/60 has-[[data-state=checked]]:bg-brand-500/10"
                    >
                      <RadioGroupItem
                        value={value}
                        aria-label={value === 'automatic' ? 'Automatic' : 'Manual'}
                      />
                      <span>
                        <span className="block text-sm font-medium capitalize">{value}</span>
                        <span className="block text-xs text-muted-foreground">
                          {value === 'automatic'
                            ? 'One preferred model per configured subscription.'
                            : 'Choose any enabled models to share the work.'}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>

                <div className="rounded-xl border border-border bg-background/50">
                  <div className="border-b border-border px-4 py-3 text-sm font-medium">
                    {mode === 'automatic' ? 'Automatic candidates' : 'Choose models'}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {selectedCandidates.length === 0 && mode === 'automatic' && (
                      <div className="px-4 py-5 text-sm text-muted-foreground">
                        No enabled model subscriptions were found.
                      </div>
                    )}
                    {groups.map((group) => {
                      const visibleCandidates = (
                        mode === 'automatic' ? automaticCandidates : group.candidates
                      ).filter((candidate) => candidate.providerKey === group.key);
                      return (
                        <ProviderModelGroup
                          key={group.key}
                          label={group.label}
                          enabled={group.enabled}
                          modelCount={group.candidates.length}
                          open={expandedGroups.has(group.key)}
                          onOpenChange={(nextOpen) => {
                            setExpandedGroups((current) => {
                              const next = new Set(current);
                              if (nextOpen) next.add(group.key);
                              else next.delete(group.key);
                              return next;
                            });
                          }}
                          onEnabledChange={(enabled) => {
                            invalidateVerification();
                            if (!enabled) {
                              const groupKeys = new Set(
                                group.candidates.map((candidate) => candidate.key)
                              );
                              setManualKeys((current) =>
                                current.filter((key) => !groupKeys.has(key))
                              );
                            } else {
                              setExpandedGroups((current) => new Set(current).add(group.key));
                            }
                            void setProviderEnabled(group.key, enabled);
                          }}
                        >
                          <div className="divide-y divide-border">
                            {group.enabled && visibleCandidates.length === 0 && (
                              <div className="px-10 py-3 text-xs text-muted-foreground">
                                No automatic candidate selected from this provider.
                              </div>
                            )}
                            {group.enabled &&
                              visibleCandidates.map((candidate) => {
                                const result = verification[candidate.key];
                                const selected =
                                  mode === 'automatic' || manualKeys.includes(candidate.key);
                                return (
                                  <div
                                    key={candidate.key}
                                    className="flex items-center gap-3 px-4 py-3 pl-10"
                                  >
                                    {mode === 'manual' && (
                                      <Checkbox
                                        aria-label={`${candidate.providerLabel} · ${candidate.displayName}`}
                                        checked={selected}
                                        onCheckedChange={(checked) => {
                                          setManualKeys((current) =>
                                            checked
                                              ? [...current, candidate.key]
                                              : current.filter((key) => key !== candidate.key)
                                          );
                                          invalidateVerification();
                                        }}
                                      />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium">
                                        {candidate.displayName}
                                      </div>
                                    </div>
                                    {selected && (
                                      <div
                                        aria-label={`${candidate.displayName} verification status`}
                                        className="text-xs font-medium text-muted-foreground"
                                      >
                                        {phase === 'verifying'
                                          ? 'Verifying'
                                          : result?.status === 'verified'
                                            ? 'Verified'
                                            : result?.status === 'unavailable'
                                              ? 'Unavailable'
                                              : 'Pending'}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                        </ProviderModelGroup>
                      );
                    })}
                  </div>
                </div>

                {Object.values(verification).some((result) => result.status === 'unavailable') && (
                  <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    {Object.values(verification)
                      .filter((result) => result.status === 'unavailable')
                      .map((result) => (
                        <div key={result.key} className="flex gap-2">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                          <span>{result.error ?? 'This model is unavailable.'}</span>
                        </div>
                      ))}
                  </div>
                )}

                {preview && (
                  <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <ShieldCheck className="h-4 w-4 text-green-500" /> Verified distribution
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {preview.counts
                        .filter(({ count }) => count > 0)
                        .map(({ candidate, count }) => (
                          <div
                            key={candidate.key}
                            className="rounded-lg border border-border bg-background/70 p-3"
                          >
                            <div className="truncate text-sm font-medium">
                              {candidate.displayName}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {count} feature{count === 1 ? '' : 's'}
                            </div>
                          </div>
                        ))}
                    </div>
                    <details className="mt-3 text-sm">
                      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                        <ChevronDown className="h-4 w-4" /> Feature assignments
                      </summary>
                      <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                        {preview.assignments.map((assignment) => {
                          const feature = snapshot.find((item) => item.id === assignment.featureId);
                          return (
                            <div
                              key={assignment.featureId}
                              className="flex justify-between gap-3 text-xs"
                            >
                              <span className="truncate">
                                {feature?.title || assignment.featureId}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {assignment.candidate.displayName}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                )}
              </>
            )}

            {(catalogError || operationError) && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {catalogError?.message ?? operationError}
              </div>
            )}
          </div>
        )}

        {phase === 'applying' && (
          <div className="space-y-4 py-8">
            <div className="flex items-center justify-between text-sm">
              <span>
                {progress.completed} of {progress.total} features updated
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Model assignment progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
            >
              <div className="h-full bg-brand-500" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-brand-500" /> Saving assignments
            </div>
          </div>
        )}

        {phase === 'complete' && (
          <div className="py-6">
            {failedAssignments.length === 0 && orchestrationFailedIds.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-6 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-500" />
                <div className="font-medium">All assignments saved</div>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                <div className="font-medium">
                  {failedAssignments.length + orchestrationFailedIds.length} assignment
                  {failedAssignments.length + orchestrationFailedIds.length === 1 ? '' : 's'} failed
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Successful assignments are already saved.
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === 'setup' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {assignmentKind === 'single' ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void verify()}
                    disabled={isLoading || selectedCandidates.length === 0}
                  >
                    <ShieldCheck className="mr-2 h-4 w-4" /> Verify Models
                  </Button>
                  <Button
                    onClick={() => preview && void apply(preview.assignments)}
                    disabled={!preview}
                  >
                    Apply Distribution
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => void applyOrchestration(snapshot)}
                  disabled={!bulkOrchestrationVerified || !bulkOrchestration}
                >
                  Apply Orchestrated Teams
                </Button>
              )}
            </>
          )}
          {phase === 'verifying' && (
            <Button disabled>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying Models
            </Button>
          )}
          {phase === 'complete' && (
            <>
              {failedAssignments.length > 0 && (
                <Button variant="outline" onClick={() => void apply(failedAssignments)}>
                  Retry Failed
                </Button>
              )}
              {orchestrationFailedIds.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void applyOrchestration(
                      snapshot.filter((feature) => orchestrationFailedIds.includes(feature.id))
                    )
                  }
                >
                  Retry Failed
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
