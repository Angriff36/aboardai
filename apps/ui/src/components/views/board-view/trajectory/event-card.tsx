import { useState } from 'react';
import type { NormalizedEvent } from '@aboardai/types';
import { DiffView } from './diff-view';

const pill = 'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium';

/**
 * Defense-in-depth: NormalizedEvent.text should always be a string, but events
 * persisted before the normalizer flattened array-shaped tool_result content may
 * still carry an object/array. Rendering that directly throws React error #31, so
 * coerce to a string at the render boundary.
 */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).join('\n');
  if (typeof value === 'object') {
    const t = (value as { text?: unknown }).text;
    return typeof t === 'string' ? t : JSON.stringify(value);
  }
  return String(value);
}

export function EventCard({ event }: { event: NormalizedEvent }) {
  const [open, setOpen] = useState(false);

  switch (event.kind) {
    case 'thinking':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1">
          <button
            className="flex items-center gap-2 text-xs w-full text-left"
            onClick={() => setOpen((o) => !o)}
          >
            <span className={`${pill} bg-amber-500/20 text-amber-600`}>thinking</span>
            <span className="text-muted-foreground">{open ? 'hide' : 'reasoning'}</span>
          </button>
          {open && event.text && (
            <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">
              {asText(event.text)}
              {event.thinkingTruncated && <span className="italic"> … truncated</span>}
            </p>
          )}
        </div>
      );

    case 'command_run':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span className={`${pill} bg-blue-500/20 text-blue-600 mr-2`}>run</span>
          <code className="font-mono">{event.command?.command}</code>
        </div>
      );

    case 'file_edit':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setOpen((o) => !o)}
          >
            <span className={`${pill} bg-purple-500/20 text-purple-600`}>edit</span>
            <code className="font-mono">{event.file?.path}</code>
            {event.file?.diff && (
              <span className="ml-auto font-mono text-muted-foreground">
                <span className="text-green-500">+{event.file.diff.adds}</span>{' '}
                <span className="text-red-500">−{event.file.diff.dels}</span>
              </span>
            )}
          </button>
          {open && event.file?.diff && <DiffView diff={event.file.diff} />}
        </div>
      );

    case 'tool_result':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span className={`${pill} bg-emerald-500/20 text-emerald-600 mr-2`}>output</span>
          <pre className="mt-1 font-mono whitespace-pre-wrap text-muted-foreground">
            {asText(event.text)}
            {event.textTruncated && <span className="italic"> … truncated</span>}
          </pre>
        </div>
      );

    case 'result':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs">
          <span
            className={`${pill} ${event.result?.isError ? 'bg-red-500/20 text-red-600' : 'bg-zinc-500/20'} mr-2`}
          >
            result
          </span>
          {event.result?.isError ? 'Error' : 'Complete'}
        </div>
      );

    case 'agent_message':
    case 'summary':
    case 'error':
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 my-1 text-xs whitespace-pre-wrap">
          <span className={`${pill} bg-zinc-500/20 mr-2`}>
            {event.kind === 'error' ? 'error' : event.kind === 'summary' ? 'summary' : 'message'}
          </span>
          {asText(event.text)}
        </div>
      );

    default:
      // tool_use / question / status / session — compact generic line (forward-compatible)
      return (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-1.5 my-1 text-xs text-muted-foreground">
          <span className={`${pill} bg-zinc-500/20 mr-2`}>{event.kind}</span>
          {event.tool?.name ?? event.status?.status ?? ''}
        </div>
      );
  }
}
