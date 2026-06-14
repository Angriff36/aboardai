import type { FileDiff } from '@aboardai/types';

export function DiffView({ diff }: { diff: FileDiff }) {
  const rows = diff.unified.split('\n');
  return (
    <pre className="mt-1 text-xs font-mono whitespace-pre-wrap rounded-md bg-muted/50 p-2 overflow-x-auto">
      {rows.map((line, i) => {
        const cls = line.startsWith('+')
          ? 'text-green-500'
          : line.startsWith('-')
            ? 'text-red-500'
            : 'text-muted-foreground';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
      {diff.truncated && <div className="text-muted-foreground italic">… diff truncated</div>}
    </pre>
  );
}
