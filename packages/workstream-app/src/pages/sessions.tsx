import { useState, useCallback } from "react";
import {
  Monitor,
  GitBranch,
  Send,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useInstances, type InstanceWithMetadata } from "@/hooks/use-instances";

function getClaudeStatusLabel(instance: InstanceWithMetadata): string {
  const cs = instance.claudeStatus;
  if (!cs || !cs.active) return "idle";
  if (cs.isCompacting) return "compacting";
  if (cs.isWorking) return "working";
  if (cs.isWaiting) return "waiting";
  return "idle";
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    working: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    waiting: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    idle: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    compacting: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    checking: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    finished: "bg-green-500/20 text-green-400 border-green-500/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        styles[status] ?? styles.idle
      )}
    >
      {status === "working" && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
        </span>
      )}
      {status === "compacting" && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-500" />
        </span>
      )}
      {status}
    </span>
  );
}

function PRBadge({ prStatus }: { prStatus: NonNullable<InstanceWithMetadata["prStatus"]> }) {
  const checks = prStatus.checks;

  return (
    <a
      href={prStatus.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="font-medium">#{prStatus.number}</span>
      {checks && (
        <span className="flex items-center gap-1">
          {checks.conclusion === "success" && <CheckCircle className="h-3 w-3 text-green-400" />}
          {checks.conclusion === "failure" && <XCircle className="h-3 w-3 text-red-400" />}
          {checks.conclusion === "pending" && <Clock className="h-3 w-3 text-yellow-400" />}
          <span>
            {checks.passing}/{checks.total}
          </span>
        </span>
      )}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function GitDirtyIndicator({ gitInfo }: { gitInfo: NonNullable<InstanceWithMetadata["gitInfo"]> }) {
  if (!gitInfo.isDirty) return null;

  const parts: string[] = [];
  if (gitInfo.modified > 0) parts.push(`${gitInfo.modified}M`);
  if (gitInfo.staged > 0) parts.push(`${gitInfo.staged}S`);
  if (gitInfo.untracked > 0) parts.push(`${gitInfo.untracked}U`);

  return (
    <span className="inline-flex items-center gap-1 text-xs text-yellow-400">
      <AlertTriangle className="h-3 w-3" />
      {parts.join(" ")}
    </span>
  );
}

function CommandInput({
  instancePath,
  instanceName,
}: {
  instancePath: string;
  instanceName: string;
}) {
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const sendCommand = useCallback(
    async (cmd: string) => {
      if (!cmd.trim()) return;
      setSending(true);
      setLastResult(null);
      try {
        const res = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: cmd,
            target: instancePath,
            source: "workstream-app",
          }),
        });
        const ok = res.ok;
        const text = await res.text().catch(() => "");
        setLastResult({ ok, message: ok ? "Sent" : text || "Failed" });
        if (ok) setCommand("");
      } catch {
        setLastResult({ ok: false, message: "Network error" });
      } finally {
        setSending(false);
      }
    },
    [instancePath]
  );

  const quickActions = [
    { label: "/fix-pr", command: "/fix-pr" },
    { label: "/create-pr-and-fix", command: "/create-pr-and-fix" },
  ];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendCommand(command);
            }
          }}
          placeholder={`Send command to ${instanceName}...`}
          disabled={sending}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          onClick={() => sendCommand(command)}
          disabled={sending || !command.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {quickActions.map((action) => (
          <button
            key={action.command}
            onClick={() => sendCommand(action.command)}
            disabled={sending}
            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {action.label}
          </button>
        ))}
      </div>

      {lastResult && (
        <p
          className={cn(
            "text-xs",
            lastResult.ok ? "text-green-400" : "text-red-400"
          )}
        >
          {lastResult.message}
        </p>
      )}
    </div>
  );
}

function SessionCard({ instance }: { instance: InstanceWithMetadata }) {
  const [expanded, setExpanded] = useState(false);
  const status = getClaudeStatusLabel(instance);
  const branch = instance.gitInfo?.branch ?? instance.branch;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card transition-colors",
        expanded && "ring-1 ring-ring"
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <div className="flex-shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{instance.name}</h3>
            <StatusBadge status={status} />
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-3">
            {branch && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                {branch}
              </span>
            )}
            {instance.gitInfo && <GitDirtyIndicator gitInfo={instance.gitInfo} />}
            {instance.prStatus && <PRBadge prStatus={instance.prStatus} />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          <CommandInput instancePath={instance.path} instanceName={instance.name} />
        </div>
      )}
    </div>
  );
}

export function SessionsPage() {
  const { instances, connected } = useInstances();

  const sorted = [...instances].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      working: 0,
      waiting: 1,
      compacting: 2,
      checking: 3,
      idle: 4,
      finished: 5,
    };
    const aStatus = getClaudeStatusLabel(a);
    const bStatus = getClaudeStatusLabel(b);
    const aPriority = statusOrder[aStatus] ?? 4;
    const bPriority = statusOrder[bStatus] ?? 4;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return b.lastUpdated - a.lastUpdated;
  });

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <Monitor className="h-12 w-12 animate-pulse" />
        <h2 className="text-xl font-semibold text-foreground">Connecting...</h2>
        <p className="text-sm">Waiting for daemon connection on port 9995</p>
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <Monitor className="h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">No Active Sessions</h2>
        <p className="text-sm">Sessions will appear here when Claude Code instances are running.</p>
      </div>
    );
  }

  const workingCount = sorted.filter((i) => getClaudeStatusLabel(i) === "working").length;
  const waitingCount = sorted.filter((i) => getClaudeStatusLabel(i) === "waiting").length;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">
          Sessions{" "}
          <span className="text-sm font-normal text-muted-foreground">({instances.length})</span>
        </h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {workingCount > 0 && (
            <span className="text-blue-400">{workingCount} working</span>
          )}
          {waitingCount > 0 && (
            <span className="text-yellow-400">{waitingCount} waiting</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {sorted.map((instance) => (
          <SessionCard key={instance.path} instance={instance} />
        ))}
      </div>
    </div>
  );
}
