import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  ExternalLink,
  Play,
  X,
  CheckCircle,
  Loader2,
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
  url: string;
  contentMarkdown?: string;
}

type FilterTab = "all" | "to_do" | "in_progress";

function StatusBadge({ statusGroup, status }: { statusGroup: string; status: string }) {
  const styles: Record<string, string> = {
    to_do: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    in_progress: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    complete: "bg-green-500/20 text-green-400 border-green-500/30",
    unknown: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        styles[statusGroup] ?? styles.unknown
      )}
    >
      {status || statusGroup}
    </span>
  );
}

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
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        styles[type] ?? "bg-violet-500/20 text-violet-400 border-violet-500/30"
      )}
    >
      {type}
    </span>
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
  const defaultPrompt = `Work on task ${task.taskId}: ${task.title}\n\n${task.contentMarkdown || ""}`;
  const [prompt, setPrompt] = useState(defaultPrompt);

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
            <p className="font-mono text-sm text-foreground">{task.branchName}</p>
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
            <label className="mb-1 block text-sm text-muted-foreground">
              Prompt Preview
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

export function NotionTrackerPage() {
  const [tasks, setTasks] = useState<NotionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>("all");
  const [startWorkTask, setStartWorkTask] = useState<NotionTask | null>(null);
  const [startWorkResult, setStartWorkResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const { instances } = useInstances();

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

  const filteredTasks =
    filter === "all"
      ? tasks
      : tasks.filter((t) => t.statusGroup === filter);

  // Check if a task's branch has an active session
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
        // Refresh tasks to show updated status
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

  const tabs: { label: string; value: FilterTab }[] = [
    { label: "All", value: "all" },
    { label: "To Do", value: "to_do" },
    { label: "In Progress", value: "in_progress" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Notion Tracker</h1>
        <button
          onClick={fetchTasks}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded border border-zinc-700 px-3 py-1.5 text-sm text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
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

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              filter === tab.value
                ? "bg-zinc-700 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            <span className="ml-1.5 text-xs opacity-60">
              {tab.value === "all"
                ? tasks.length
                : tasks.filter((t) => t.statusGroup === tab.value).length}
            </span>
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
      {!loading && !error && filteredTasks.length === 0 && (
        <div className="py-16 text-center text-muted-foreground">
          <p className="text-sm">No tasks found.</p>
        </div>
      )}

      {/* Task table */}
      {filteredTasks.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Branch</th>
                <th className="px-4 py-3">Session</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {filteredTasks.map((task) => {
                const activeSession = getActiveSession(task);

                return (
                  <tr
                    key={task.id}
                    className="transition-colors hover:bg-zinc-900/50"
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                      {task.taskId}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {task.title}
                        </span>
                        <a
                          href={task.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        statusGroup={task.statusGroup}
                        status={task.status}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={task.type} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {task.branchName}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {activeSession ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                          </span>
                          Active
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {task.statusGroup === "to_do" && !activeSession && (
                        <button
                          onClick={() => setStartWorkTask(task)}
                          className="inline-flex items-center gap-1.5 rounded bg-blue-600/20 px-2.5 py-1 text-xs font-medium text-blue-400 hover:bg-blue-600/30"
                        >
                          <Play className="h-3 w-3" />
                          Start Work
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
