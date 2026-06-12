import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import type { Feature, TaskGroupSnapshot } from '@aboardai/types';
import { getHttpApiClient } from '@/lib/http-api-client';

interface CreateGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (group: TaskGroupSnapshot) => void;
  projectPath: string;
  features: Feature[];
  branchSuggestions: string[];
}

export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
  projectPath,
  features,
  branchSuggestions,
}: CreateGroupDialogProps) {
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [retryLimit, setRetryLimit] = useState(1);
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      setBaseBranch('');
      setMaxConcurrency(3);
      setRetryLimit(1);
      setSelectedFeatureIds(new Set());
    }
  }, [open]);

  const eligibleFeatures = features.filter((f) => f.status === 'backlog' || f.status === 'ready');

  const selectedCount = selectedFeatureIds.size;
  const isSelectionValid = selectedCount >= 2 && selectedCount <= 20;
  const canSubmit = name.trim().length > 0 && isSelectionValid && !submitting;

  const toggleFeature = (id: string) => {
    setSelectedFeatureIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const api = getHttpApiClient();
      const result = await api.groups.create(
        projectPath,
        name.trim(),
        baseBranch.trim() || null,
        maxConcurrency,
        retryLimit,
        Array.from(selectedFeatureIds)
      );
      if (result.success && result.group) {
        toast.success(`Group "${name.trim()}" created`);
        onCreated(result.group);
        onOpenChange(false);
      } else if (result.guard) {
        toast.error(result.guard);
      } else {
        toast.error(result.error ?? 'Failed to create group');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setSubmitting(false);
    }
  };

  const datalistId = 'create-group-branch-suggestions';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Group</DialogTitle>
          <DialogDescription>
            Run a batch of features concurrently with shared settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">Group Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Sprint 1"
            />
          </div>

          {/* Features */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>Features</Label>
              <span className="text-xs text-muted-foreground">{selectedCount} selected</span>
            </div>
            {eligibleFeatures.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No eligible features (backlog or ready).
              </p>
            ) : (
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border rounded-md p-2">
                {eligibleFeatures.map((f) => {
                  const label = f.title || (f.description ? f.description.slice(0, 60) : f.id);
                  return (
                    <label
                      key={f.id}
                      className="flex items-center gap-2 cursor-pointer py-1 px-1 rounded hover:bg-secondary/50"
                    >
                      <Checkbox
                        checked={selectedFeatureIds.has(f.id)}
                        onCheckedChange={() => toggleFeature(f.id)}
                      />
                      <span className="text-sm flex-1 truncate">{label}</span>
                      {f.category && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">
                          {f.category}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            {!isSelectionValid && selectedCount > 0 && (
              <p className="text-xs text-destructive">Select 2–20 features</p>
            )}
            {selectedCount === 0 && eligibleFeatures.length > 0 && (
              <p className="text-xs text-muted-foreground">Select 2–20 features</p>
            )}
          </div>

          {/* Base Branch */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-base-branch">Base Branch (optional)</Label>
            <input
              id="group-base-branch"
              list={datalistId}
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="e.g., main"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <datalist id={datalistId}>
              {branchSuggestions.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>

          {/* Max Concurrency */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>Max Concurrency</Label>
              <span className="text-xs font-medium">{maxConcurrency}</span>
            </div>
            <Slider
              value={[maxConcurrency]}
              onValueChange={(val) => setMaxConcurrency(val[0])}
              min={1}
              max={10}
              step={1}
              className="flex-1"
            />
          </div>

          {/* Retry Limit */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-retry-limit">Retry Limit per Child</Label>
            <Input
              id="group-retry-limit"
              type="number"
              min={0}
              max={5}
              value={retryLimit}
              onChange={(e) =>
                setRetryLimit(Math.min(5, Math.max(0, parseInt(e.target.value, 10) || 0)))
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create Group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
