import { useEffect, useRef, useState } from 'react';
import { FileInput, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { HotkeyButton } from '@/components/ui/hotkey-button';
import { cn } from '@/lib/utils';
import { getElectronAPI } from '@/lib/electron';
import type { SpecRegenerationEvent } from '@/types/electron';
import { useImportDocument } from '@/hooks/mutations';
import { FEATURE_COUNT_OPTIONS } from '@/components/views/spec-view/constants';
import type { FeatureCount } from '@/components/views/spec-view/types';

interface ImportDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
}

/**
 * Import any structured document (audit register, implementation plan, PRD, checklist,
 * roadmap, design notes) and break it into board tasks (features).
 *
 * Paste the document text, optionally cap the number of tasks, and submit. Extraction
 * runs in the background on the server and emits on the shared `spec-regeneration:event`
 * channel — the board refreshes itself via the global query-invalidation handler when
 * `spec_regeneration_complete` fires. This dialog listens to that stream only to show
 * progress and to surface success/error.
 */
export function ImportDocumentDialog({
  open,
  onOpenChange,
  projectPath,
}: ImportDocumentDialogProps) {
  const [documentText, setDocumentText] = useState('');
  const [maxFeatures, setMaxFeatures] = useState<FeatureCount>(50);
  const [isImporting, setIsImporting] = useState(false);
  const [phase, setPhase] = useState('');

  const importMutation = useImportDocument(projectPath);
  const isImportingRef = useRef(false);

  const selectedOption = FEATURE_COUNT_OPTIONS.find((o) => o.value === maxFeatures);

  useEffect(() => {
    isImportingRef.current = isImporting;
  }, [isImporting]);

  useEffect(() => {
    if (!open) return;
    const api = getElectronAPI();
    if (!api.specRegeneration?.onEvent) return;

    const unsubscribe = api.specRegeneration.onEvent((event: SpecRegenerationEvent) => {
      if (event.projectPath && event.projectPath !== projectPath) return;
      if (!isImportingRef.current) return;

      if (event.type === 'spec_regeneration_complete') {
        setIsImporting(false);
        setPhase('');
        toast.success('Tasks imported to the board');
        onOpenChange(false);
        setDocumentText('');
      } else if (event.type === 'spec_regeneration_error') {
        setIsImporting(false);
        setPhase('');
        toast.error(event.error || 'Document import failed');
      } else if (event.type === 'spec_regeneration_progress') {
        setPhase('Extracting tasks…');
      }
    });

    return () => unsubscribe();
  }, [open, projectPath, onOpenChange]);

  const handleImport = () => {
    if (!documentText.trim() || isImporting) return;
    setIsImporting(true);
    setPhase('Starting…');
    importMutation.mutate(
      { documentText, maxFeatures },
      {
        onError: (error) => {
          setIsImporting(false);
          setPhase('');
          toast.error(error instanceof Error ? error.message : 'Failed to start document import');
        },
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isImporting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Tasks from a Document</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste any structured document — an audit register, implementation plan, PRD, roadmap, or
            checklist. The agent breaks it into board tasks, preserving the document&apos;s ordering
            as task dependencies so auto-mode runs them in the right sequence.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-y-auto">
          <div className="space-y-2">
            <label className="text-sm font-medium">Document content</label>
            <textarea
              className="w-full h-64 p-3 rounded-md border border-border bg-background font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              value={documentText}
              onChange={(e) => setDocumentText(e.target.value)}
              placeholder="Paste your IMPLEMENTATION_PLAN.md, audit register, PRD, or checklist here…"
              disabled={isImporting}
              data-testid="import-document-text"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Maximum tasks</label>
            <div className="flex gap-2">
              {FEATURE_COUNT_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={maxFeatures === option.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMaxFeatures(option.value as FeatureCount)}
                  disabled={isImporting}
                  className={cn(
                    'flex-1 transition-all',
                    maxFeatures === option.value
                      ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                      : 'bg-muted/30 hover:bg-muted/50 border-border'
                  )}
                  data-testid={`import-max-tasks-${option.value}`}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {selectedOption?.warning && (
              <p className="text-xs text-amber-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {selectedOption.warning}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              A soft cap — the agent extracts only the work items the document actually contains.
            </p>
          </div>
        </div>

        <DialogFooter>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isImporting}>
              Cancel
            </Button>
            <HotkeyButton
              onClick={handleImport}
              disabled={!documentText.trim() || isImporting}
              hotkey={{ key: 'Enter', cmdCtrl: true }}
              hotkeyActive={open && !isImporting}
              data-testid="import-document-submit"
            >
              {isImporting ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  {phase || 'Importing…'}
                </>
              ) : (
                <>
                  <FileInput className="w-4 h-4 mr-2" />
                  Import Tasks
                </>
              )}
            </HotkeyButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
