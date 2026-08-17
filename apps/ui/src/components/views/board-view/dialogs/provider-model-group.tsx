import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface ProviderModelGroupProps {
  label: string;
  enabled: boolean;
  modelCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  children: React.ReactNode;
}

export function ProviderModelGroup({
  label,
  enabled,
  modelCount,
  open,
  onOpenChange,
  onEnabledChange,
  children,
}: ProviderModelGroupProps) {
  return (
    <Collapsible open={enabled && open} onOpenChange={onOpenChange}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <CollapsibleTrigger asChild disabled={!enabled}>
          <button
            type="button"
            aria-label={`Toggle ${label} models`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/50 disabled:cursor-default disabled:opacity-60"
          >
            <ChevronRight
              className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')}
            />
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {modelCount} model{modelCount === 1 ? '' : 's'}
            </span>
          </button>
        </CollapsibleTrigger>
        <Switch
          aria-label={`Use ${label}`}
          checked={enabled}
          onCheckedChange={onEnabledChange}
          className="h-5 w-9 data-[state=checked]:bg-brand-500 [&>span]:h-4 [&>span]:w-4 data-[state=checked]:[&>span]:translate-x-4"
        />
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
