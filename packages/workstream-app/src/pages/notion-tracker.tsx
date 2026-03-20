import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  ExternalLink,
  Play,
  X,
  CheckCircle,
  Loader2,
  ChevronDown,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useInstances } from "@/hooks/use-instances";

interface NotionTask {
  id: string;
  taskId: string;
  title: string;
  branchName: string;
  status: string;
  statusGroup: "to_do" | "in_progress" | "complete" | "unknown";
  type?: string;
  assignee?: { id: string; name: string; avatarUrl?: string };
  url: string;
  contentMarkdown?: string;
}

// Column definition: each status gets its own column, grouped visually
interface ColumnDef {
  status: string;
  statusGroup: "to_do" | "in_progress" | "complete" | "unknown";
}

const STATUS_GROUP_ORDER: Record<string, number> = {
  to_do: 0,
  in_progress: 1,
  complete: 2,
  unknown: 3,
};

const STATUS_GROUP_LABELS: Record<string, string> = {
  to_do: "To Do",
  in_progress: "In Progress",
  complete: "Complete",
  unknown: "Other",
};

const STATUS_GROUP_HEADER_COLORS: Record<string, string> = {
  to_do: "border-zinc-500/40 bg-zinc-800/60",
  in_progress: "border-blue-500/40 bg-blue-900/20",
  complete: "border-green-500/40 bg-green-900/20",
  unknown: "border-yellow-500/40 bg-yellow-900/20",
};

const STATUS_GROUP_DOT_COLORS: Record<string, string> = {
  to_do: "bg-zinc-400",
  in_progress: "bg-blue-400",
  complete: "bg-green-400",
  unknown: "bg-yellow-400",
};

function TypeBadge({ type }: { type?: string }) {
  if (!type) return null;

  const styles: Record<string, string> = {
    Bug: "bg-red-500/20 text-red-400 border-red-500/30",
    Feature: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    Improvement: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    Chore: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4",
        styles[type] ?? "bg-violet-500/20 text-violet-400 border-violet-500/30"
      )}
    >
      {type}
    </span>
  );
}

function AssigneeAvatar({
  assignee,
  size = "sm",
}: {
  assignee?: { id: string; name: string; avatarUrl?: string };
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const textSize = size === "sm" ? "text-[9px]" : "text-[10px]";

  if (!assignee) {
    return (
      <div
        className={cn(
          dims,
          "rounded-full bg-zinc-700 flex items-center justify-center"
        )}
      >
        <User className="h-3 w-3 text-zinc-500" />
      </div>
    );
  }

  if (assignee.avatarUrl) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={assignee.name}
        title={assignee.name}
        className={cn(dims, "rounded-full object-cover")}
      />
    );
  }

  const initials = assignee.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div
      className={cn(
        dims,
        textSize,
        "rounded-full bg-blue-600 flex items-center justify-center font-medium text-white"
      )}
      title={assignee.name}
    >
      {initials}
    </div>
  );
}

function StartWorkModal({
  task,
  onClose,
  onStart,
}: {
  task: NotionTask;
  onClose: () => void;
  onStart: (repoPath: string, prompt: string) => void;
}) {
  const [repoPath, setRepoPath] = useState("/Users/adamhancock/Code/assurix");
  const [isStarting, setIsStarting] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [prompt, setPrompt] = useState(
    `Work on task ${task.taskId}: ${task.title}`
  );

  useEffect(() => {
    fetch(`/api/notion/tasks/${task.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((detail) => {
        if (detail?.contentMarkdown) {
          setPrompt(
            `Work on task ${task.taskId}: ${task.title}\n\n${detail.contentMarkdown}`
          );
        }
      })
      .catch(() => {})
      .finally(() => setLoadingDetails(false));
  }, [task.id, task.taskId, task.title]);

  const handleStart = async () => {
    setIsStarting(true);
    onStart(repoPath, prompt);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-700 px-6 py-4">
          <h3 className="text-lg font-semibold text-foreground">Start Work</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div>
            <p className="text-sm text-muted-foreground">Task</p>
            <p className="font-medium text-foreground">
              {task.taskId}: {task.title}
            </p>
          </div>

          <div>
            <p className="text-sm text-muted-foreground">Branch</p>
            <p className="font-mono text-sm text-foreground">
              {task.branchName}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm text-muted-foreground">
              Repository Path
            </label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
              Prompt Preview
              {loadingDetails && <Loader2 className="h-3 w-3 animate-spin" />}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-foreground focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-zinc-700 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={isStarting || !repoPath}
            className={cn(
              "inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700",
              (isStarting || !repoPath) && "cursor-not-allowed opacity-50"
            )}
          >
            {isStarting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Start
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserFilterDropdown({
  assignees,
  selectedUserId,
  onChange,
}: {
  assignees: { id: string; name: string; avatarUrl?: string }[];
  selectedUserId: string;
  onChange: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const selectedUser = assignees.find((a) => a.id === selectedUserId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
      >
        {selectedUser ? (
          <>
            <AssigneeAvatar assignee={selectedUser} size="sm" />
            <span>{selectedUser.name}</span>
          </>
        ) : (
          <>
            <User className="h-4 w-4" />
            <span>All Users</span>
          </>
        )}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
            <button
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-800",
                !selectedUserId
                  ? "text-foreground bg-zinc-800"
                  : "text-muted-foreground"
              )}
            >
              <User className="h-4 w-4" />
              All Users
            </button>
            {assignees.map((user) => (
              <button
                key={user.id}
                onClick={() => {
                  onChange(user.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-800",
                  selectedUserId === user.id
                    ? "text-foreground bg-zinc-800"
                    : "text-muted-foreground"
                )}
              >
                <AssigneeAvatar assignee={user} size="sm" />
                {user.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NotionTrackerPage() {
  const [tasks, setTasks] = useState<NotionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startWorkTask, setStartWorkTask] = useState<NotionTask | null>(null);
  const [startWorkResult, setStartWorkResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const { instances } = useInstances();

  // Persisted filters
  const [userFilter, setUserFilter] = useState<string>(() => {
    try {
      return localStorage.getItem("workstream:notion:userFilter") || "";
    } catch {
      return "";
    }
  });

  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("workstream:notion:statusFilter");
      if (stored) return new Set(JSON.parse(stored));
    } catch {}
    return new Set<string>();
  });

  // Persist user filter
  useEffect(() => {
    try {
      localStorage.setItem("workstream:notion:userFilter", userFilter);
    } catch {}
  }, [userFilter]);

  // Persist status group filter
  useEffect(() => {
    try {
      localStorage.setItem(
        "workstream:notion:statusFilter",
        JSON.stringify(Array.from(hiddenGroups))
      );
    } catch {}
  }, [hiddenGroups]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/notion/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Extract unique assignees
  const assignees = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; avatarUrl?: string }
    >();
    for (const task of tasks) {
      if (task.assignee && !map.has(task.assignee.id)) {
        map.set(task.assignee.id, task.assignee);
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [tasks]);

  // Filter tasks by user
  const userFilteredTasks = useMemo(() => {
    if (!userFilter) return tasks;
    return tasks.filter((t) => t.assignee?.id === userFilter);
  }, [tasks, userFilter]);

  // Build columns from actual statuses present in filtered tasks
  const columns = useMemo(() => {
    const statusMap = new Map<string, ColumnDef>();
    for (const task of userFilteredTasks) {
      if (!statusMap.has(task.status)) {
        statusMap.set(task.status, {
          status: task.status,
          statusGroup: task.statusGroup,
        });
      }
    }
    return Array.from(statusMap.values()).sort((a, b) => {
      const groupDiff =
        (STATUS_GROUP_ORDER[a.statusGroup] ?? 3) -
        (STATUS_GROUP_ORDER[b.statusGroup] ?? 3);
      if (groupDiff !== 0) return groupDiff;
      return a.status.localeCompare(b.status);
    });
  }, [userFilteredTasks]);

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const map = new Map<string, NotionTask[]>();
    for (const task of userFilteredTasks) {
      const list = map.get(task.status) || [];
      list.push(task);
      map.set(task.status, list);
    }
    return map;
  }, [userFilteredTasks]);

  // Visible columns (filtered by status group)
  const visibleColumns = useMemo(() => {
    return columns.filter((col) => !hiddenGroups.has(col.statusGroup));
  }, [columns, hiddenGroups]);

  // Get unique status groups present
  const presentGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const col of columns) {
      groups.add(col.statusGroup);
    }
    return Array.from(groups).sort(
      (a, b) => (STATUS_GROUP_ORDER[a] ?? 3) - (STATUS_GROUP_ORDER[b] ?? 3)
    );
  }, [columns]);

  const getActiveSession = (task: NotionTask) => {
    return instances.find(
      (inst) =>
        inst.branch === task.branchName ||
        inst.path?.includes(task.branchName)
    );
  };

  const handleStartWork = async (repoPath: string, prompt: string) => {
    if (!startWorkTask) return;

    try {
      const res = await fetch("/api/worktree/start-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchName: startWorkTask.branchName,
          repoPath,
          notionTaskId: startWorkTask.id,
          prompt,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setStartWorkResult({
          success: true,
          message: `Worktree created at ${data.worktreePath}. tmux session: ${data.tmuxSession}`,
        });
        setTimeout(() => fetchTasks(), 2000);
      } else {
        setStartWorkResult({
          success: false,
          message: data.error || "Failed to start work",
        });
      }
    } catch (err) {
      setStartWorkResult({
        success: false,
        message: err instanceof Error ? err.message : "Request failed",
      });
    }

    setStartWorkTask(null);
  };

  const toggleGroup = (group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">
          Notion Tracker
        </h1>
        <div className="flex items-center gap-3">
          <UserFilterDropdown
            assignees={assignees}
            selectedUserId={userFilter}
            onChange={setUserFilter}
          />
          <button
            onClick={fetchTasks}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded border border-zinc-700 px-3 py-1.5 text-sm text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* Result banner */}
      {startWorkResult && (
        <div
          className={cn(
            "flex items-center justify-between rounded border px-4 py-3 text-sm",
            startWorkResult.success
              ? "border-green-500/30 bg-green-500/10 text-green-400"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          )}
        >
          <div className="flex items-center gap-2">
            {startWorkResult.success ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <X className="h-4 w-4" />
            )}
            {startWorkResult.message}
          </div>
          <button
            onClick={() => setStartWorkResult(null)}
            className="rounded p-1 hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Status group filter toggles */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Show:</span>
        {presentGroups.map((group) => (
          <button
            key={group}
            onClick={() => toggleGroup(group)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors border",
              hiddenGroups.has(group)
                ? "border-zinc-800 bg-zinc-900/50 text-zinc-600"
                : "border-zinc-700 bg-zinc-800 text-foreground"
            )}
          >
            {STATUS_GROUP_LABELS[group] || group}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && tasks.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading tasks...
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && userFilteredTasks.length === 0 && (
        <div className="py-16 text-center text-muted-foreground">
          <p className="text-sm">No tasks found.</p>
        </div>
      )}

      {/* Kanban Board */}
      {visibleColumns.length > 0 && (
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-3 pb-4" style={{ minHeight: "400px" }}>
            {visibleColumns.map((col) => {
              const colTasks = tasksByStatus.get(col.status) || [];
              return (
                <div
                  key={col.status}
                  className="flex w-[270px] min-w-[270px] flex-col rounded-lg border border-zinc-800 bg-zinc-950"
                >
                  {/* Column header */}
                  <div
                    className={cn(
                      "flex items-center justify-between rounded-t-lg border-b px-3 py-2",
                      STATUS_GROUP_HEADER_COLORS[col.statusGroup] ??
                        STATUS_GROUP_HEADER_COLORS.unknown
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full",
                          STATUS_GROUP_DOT_COLORS[col.statusGroup] ??
                            STATUS_GROUP_DOT_COLORS.unknown
                        )}
                      />
                      <span className="text-xs font-semibold text-foreground">
                        {col.status}
                      </span>
                    </div>
                    <span className="rounded-full bg-zinc-700/50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                      {colTasks.length}
                    </span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 space-y-2 overflow-y-auto p-2">
                    {colTasks.map((task) => {
                      const activeSession = getActiveSession(task);
                      return (
                        <div
                          key={task.id}
                          className="group rounded-md border border-zinc-800 bg-zinc-900 p-2.5 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80"
                        >
                          {/* Top row: taskId + actions */}
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-mono text-[10px] text-zinc-500">
                              {task.taskId}
                            </span>
                            <div className="flex items-center gap-1">
                              {activeSession && (
                                <span className="relative flex h-2 w-2" title="Active session">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                                </span>
                              )}
                              <a
                                href={task.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </div>

                          {/* Title */}
                          <p
                            className="mb-1.5 text-xs font-medium leading-snug text-foreground line-clamp-2 cursor-pointer"
                            title={task.title}
                            onClick={() =>
                              window.open(task.url, "_blank", "noopener")
                            }
                          >
                            {task.title}
                          </p>

                          {/* Bottom row: type + assignee + start work */}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <TypeBadge type={task.type} />
                              <AssigneeAvatar
                                assignee={task.assignee}
                                size="sm"
                              />
                            </div>
                            {task.statusGroup === "to_do" &&
                              !activeSession && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setStartWorkTask(task);
                                  }}
                                  className="inline-flex items-center gap-1 rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400 opacity-0 transition-opacity hover:bg-blue-600/30 group-hover:opacity-100"
                                >
                                  <Play className="h-2.5 w-2.5" />
                                  Start
                                </button>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Start Work Modal */}
      {startWorkTask && (
        <StartWorkModal
          task={startWorkTask}
          onClose={() => setStartWorkTask(null)}
          onStart={handleStartWork}
        />
      )}
    </div>
  );
}
