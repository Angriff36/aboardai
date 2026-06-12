import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { TaskGroupSnapshot, TaskGroupStatus, GroupChildStatus } from '@aboardai/types';
import { useGroupStore } from '@/store/group-store';
import { getHttpApiClient } from '@/lib/http-api-client';
import { CreateGroupDialog } from './dialogs/create-group-dialog';
import type { Feature } from '@aboardai/types';

interface GroupsPanelProps {
  projectPath: string;
  features: Array<{ id: string; title: string; description: string; status: string }>;
  branchSuggestions: string[];
}

const STATUS_COLORS: Record<TaskGroupStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  review: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
};

const CHILD_STATUS_DOT: Record<GroupChildStatus, string> = {
  pending: 'bg-yellow-400',
  running: 'bg-blue-400',
  retrying: 'bg-orange-400',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  skipped: 'bg-gray-400',
};

function StatusBadge({ status }: { status: TaskGroupStatus }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[status]}`}>
      {status}
    </span>
  );
}

function GroupCard({
  group,
  projectPath,
  onRefresh,
}: {
  group: TaskGroupSnapshot;
  projectPath: string;
  onRefresh: () => void;
}) {
  const completed = group.children.filter((c) => c.status === 'completed').length;
  const total = group.children.length;

  const handleStart = async () => {
    try {
      const result = await getHttpApiClient().groups.start(projectPath, group.id);
      if (result.success) {
        toast.success(`Group "${group.name}" started`);
      } else {
        toast.error(result.guard ?? result.error ?? 'Failed to start group');
      }
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start group');
    }
  };

  const handleCancel = async () => {
    try {
      const result = await getHttpApiClient().groups.cancel(projectPath, group.id);
      if (result.success) {
        toast.success(`Group "${group.name}" cancelled`);
      } else {
        toast.error(result.guard ?? result.error ?? 'Failed to cancel group');
      }
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel group');
    }
  };

  return (
    <div className="border rounded-md p-2.5 flex flex-col gap-1.5 bg-background">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm truncate flex-1">{group.name}</span>
        <StatusBadge status={group.status} />
      </div>

      <div className="text-xs text-muted-foreground">
        {completed}/{total} completed
      </div>

      {group.children.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {group.children.map((child) => (
            <span
              key={child.featureId}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-secondary"
              title={child.featureId}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${CHILD_STATUS_DOT[child.status]}`}
              />
              <span className="truncate max-w-[80px]">
                {child.featureId.length > 8 ? child.featureId.slice(0, 8) + '…' : child.featureId}
              </span>
              {child.attempts > 0 && (
                <span className="text-muted-foreground">({child.attempts}x)</span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-1.5 mt-0.5">
        {group.status === 'pending' && (
          <button
            onClick={handleStart}
            className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start
          </button>
        )}
        {(group.status === 'pending' || group.status === 'running') && (
          <button
            onClick={handleCancel}
            className="text-xs px-2 py-0.5 rounded border hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function GroupsPanel({ projectPath, features, branchSuggestions }: GroupsPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const groups = useGroupStore((s) => s.groups);

  useEffect(() => {
    const unsubFn = useGroupStore.getState().registerGroupEvents(projectPath);
    unsubRef.current = unsubFn;
    useGroupStore.getState().refresh(projectPath);
    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [projectPath]);

  const handleRefresh = () => {
    useGroupStore.getState().refresh(projectPath);
  };

  const handleCreated = (group: TaskGroupSnapshot) => {
    useGroupStore.getState().upsertGroup(group);
    handleRefresh();
  };

  // Cast features array to Feature[] for the dialog (the dialog needs the full Feature type
  // but we only have a subset — the dialog only uses title, description, status, id, category)
  const dialogFeatures = features as unknown as Feature[];

  return (
    <div className="border-b">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 flex-1 text-left"
        >
          <span className="text-sm font-medium">Groups</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            {groups.length}
          </span>
          <span className="text-xs text-muted-foreground ml-auto mr-1">
            {collapsed ? '▶' : '▼'}
          </span>
        </button>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
        >
          New Group
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2 flex flex-col gap-2">
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">
              No groups yet. Create one to run features concurrently.
            </p>
          ) : (
            groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                projectPath={projectPath}
                onRefresh={handleRefresh}
              />
            ))
          )}
        </div>
      )}

      {showCreateDialog && (
        <CreateGroupDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleCreated}
          projectPath={projectPath}
          features={dialogFeatures}
          branchSuggestions={branchSuggestions}
        />
      )}
    </div>
  );
}
