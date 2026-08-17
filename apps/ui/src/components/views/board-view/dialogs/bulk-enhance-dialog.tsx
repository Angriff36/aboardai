import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelOverrideTrigger, useModelOverride } from '@/components/shared';
import {
  ADDITIVE_MODES,
  ENHANCEMENT_MODE_DESCRIPTIONS,
  ENHANCEMENT_MODE_LABELS,
  REWRITE_MODES,
  type EnhancementMode,
} from '../shared/enhancement/enhancement-constants';
import type {
  BulkEnhancementProgress,
  BulkEnhancementResult,
} from '../shared/enhancement/bulk-enhancement';
import type { BulkEnhanceRunOptions } from '../shared/enhancement/bulk-feature-enhancement';
export type { BulkEnhanceRunOptions } from '../shared/enhancement/bulk-feature-enhancement';

interface BulkEnhanceDialogProps {
  open: boolean;
  featureCount: number;
  featureNames: Record<string, string>;
  onOpenChange: (open: boolean) => void;
  onRun: (
    options: BulkEnhanceRunOptions,
    onProgress: (progress: BulkEnhancementProgress) => void,
    featureIds?: string[]
  ) => Promise<BulkEnhancementResult>;
  onFinished: (result: BulkEnhancementResult) => void;
}

type DialogPhase = 'setup' | 'running' | 'complete';

const EMPTY_PROGRESS: BulkEnhancementProgress = { completed: 0, total: 0, failed: 0 };

export function BulkEnhanceDialog({
  open,
  featureCount,
  featureNames,
  onOpenChange,
  onRun,
  onFinished,
}: BulkEnhanceDialogProps) {
  const [mode, setMode] = useState<EnhancementMode>('improve');
  const [phase, setPhase] = useState<DialogPhase>('setup');
  const [batchFeatureCount, setBatchFeatureCount] = useState(featureCount);
  const [progress, setProgress] = useState<BulkEnhancementProgress>(EMPTY_PROGRESS);
  const [result, setResult] = useState<BulkEnhancementResult | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const wasOpen = useRef(false);
  const enhancementOverride = useModelOverride({ phase: 'enhancementModel' });

  useEffect(() => {
    if (open && !wasOpen.current) {
      setMode('improve');
      setPhase('setup');
      setBatchFeatureCount(featureCount);
      setProgress({ ...EMPTY_PROGRESS, total: featureCount });
      setResult(null);
      setBatchError(null);
    }
    wasOpen.current = open;
  }, [featureCount, open]);

  const run = async (featureIds?: string[]) => {
    const total = featureIds?.length ?? batchFeatureCount;
    setPhase('running');
    setProgress({ completed: 0, total, failed: 0 });
    setBatchError(null);

    try {
      const nextResult = await onRun(
        {
          mode,
          model: enhancementOverride.effectiveModel,
          thinkingLevel: enhancementOverride.effectiveModelEntry.thinkingLevel,
        },
        setProgress,
        featureIds
      );
      setResult(nextResult);
      setPhase('complete');
      onFinished(nextResult);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : 'Bulk enhancement failed');
      setPhase('setup');
    }
  };

  const failedIds = result?.failures.map((failure) => failure.featureId) ?? [];
  const successfulCount = result?.succeededIds.length ?? 0;
  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (phase !== 'running') onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="bulk-enhance-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-500/30 bg-brand-500/10 text-brand-500 shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>
                Enhance {batchFeatureCount} Feature{batchFeatureCount === 1 ? '' : 's'}
              </DialogTitle>
              <DialogDescription>
                Apply one existing Enhance with AI action to every selected feature.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === 'setup' && (
          <div className="space-y-4 py-3">
            <div className="rounded-xl border border-border bg-muted/20 p-4">
              <div className="mb-2 text-sm font-medium text-foreground">Enhancement</div>
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="flex-1 justify-between">
                      {ENHANCEMENT_MODE_LABELS[mode]}
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-64">
                    <DropdownMenuLabel>Rewrite</DropdownMenuLabel>
                    {REWRITE_MODES.map((item) => (
                      <DropdownMenuItem key={item} onClick={() => setMode(item)}>
                        {ENHANCEMENT_MODE_LABELS[item]}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Append Details</DropdownMenuLabel>
                    {ADDITIVE_MODES.map((item) => (
                      <DropdownMenuItem key={item} onClick={() => setMode(item)}>
                        {ENHANCEMENT_MODE_LABELS[item]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <ModelOverrideTrigger
                  currentModelEntry={enhancementOverride.effectiveModelEntry}
                  onModelChange={enhancementOverride.setOverride}
                  phase="enhancementModel"
                  isOverridden={enhancementOverride.isOverridden}
                  size="md"
                  variant="icon"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {ENHANCEMENT_MODE_DESCRIPTIONS[mode]}
              </p>
            </div>

            <div className="flex gap-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2.5 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
              <p>
                Each description is enhanced and saved independently. Existing prompts and feature
                history are preserved.
              </p>
            </div>

            {batchError && (
              <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {batchError}
              </div>
            )}
          </div>
        )}

        {phase === 'running' && (
          <div className="space-y-5 py-6">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">
                {progress.completed} of {progress.total} features enhanced
              </span>
              <span className="tabular-nums text-muted-foreground">{progressPercent}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Bulk enhancement progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-brand-500" />
              You can keep this window open while AboardAI works through the selection.
            </div>
          </div>
        )}

        {phase === 'complete' && result && (
          <div className="space-y-4 py-3">
            {result.failures.length === 0 ? (
              <div className="flex flex-col items-center rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-6 text-center">
                <CheckCircle2 className="mb-3 h-8 w-8 text-green-500" />
                <div className="font-medium text-foreground">
                  All {successfulCount} feature{successfulCount === 1 ? '' : 's'} enhanced
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Every updated description has been saved.
                </p>
              </div>
            ) : (
              <>
                <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
                  <div>
                    <div className="font-medium text-foreground">
                      {successfulCount} saved, {result.failures.length} failed
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Successful changes are already saved. Retry only the failed features below.
                    </p>
                  </div>
                </div>
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                  {result.failures.map((failure) => (
                    <div
                      key={failure.featureId}
                      className="rounded-lg border border-border bg-muted/20 px-3 py-2"
                    >
                      <div className="text-sm font-medium text-foreground">
                        {featureNames[failure.featureId] || failure.featureId}
                      </div>
                      <div className="mt-0.5 text-xs text-destructive">{failure.error}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === 'setup' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void run()}
                disabled={batchFeatureCount === 0}
                data-testid="bulk-enhance-start-button"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Enhance {batchFeatureCount} Feature{batchFeatureCount === 1 ? '' : 's'}
              </Button>
            </>
          )}
          {phase === 'complete' && (
            <>
              {failedIds.length > 0 && (
                <Button variant="outline" onClick={() => void run(failedIds)}>
                  <RotateCcw className="mr-2 h-4 w-4" />
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
