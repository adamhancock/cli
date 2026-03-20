import { useState, useCallback, useMemo } from "react";
import {
  GitPullRequest,
  GitBranch,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
  Plus,
  GitMerge,
  Ban,
  Loader2,
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

function ClaudeStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    working: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    waiting: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    idle: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    compacting: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        styles[status] ?? styles.idle
      )}
    >
      {(status === "working" || status === "compacting") && (
        <span className="relative flex h-2 w-2">
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              status === "working" ? "bg-blue-400" : "bg-purple-400"
            )}
          />
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              status === "working" ? "bg-blue-500" : "bg-purple-500"
            )}
          />
        </span>
      )}
      {status}
    </span>
  );
}

function ChecksConclusionBadge({
  conclusion,
}: {
  conclusion: "success" | "failure" | "pending";
}) {
  const config = {
    success: {
      icon: CheckCircle,
      label: "Passing",
      className: "bg-green-500/20 text-green-400 border-green-500/30",
    },
    failure: {
      icon: XCircle,
      label: "Failing",
      className: "bg-red-500/20 text-red-400 border-red-500/30",
    },
    pending: {
      icon: Clock,
      label: "Pending",
      className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    },
  };

  const { icon: Icon, label, className } = config[conclusion];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        className
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function MergeableBadge({
  mergeable,
}: {
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}) {
  if (!mergeable || mergeable === "UNKNOWN") return null;

  if (mergeable === "CONFLICTING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
        <Ban className="h-3 w-3" />
        Conflicts
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-400">
      <GitMerge className="h-3 w-3" />
      Mergeable
    </span>
  );
}

function ActionButton({
  label,
  icon: Icon,
  onClick,
  variant = "default",
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: "default" | "primary";
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const handleClick = useCallback(async () => {
    setSending(true);
    setResult(null);
    onClick();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setResult({ ok: true, message: "Sent" });
    } finally {
      setSending(false);
      setTimeout(() => setResult(null), 2000);
    }
  }, [onClick]);

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        onClick={handleClick}
        disabled={sending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
          variant === "primary"
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
        )}
      >
        {sending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {result && (
        <span
          className={cn(
            "text-xs",
            result.ok ? "text-green-400" : "text-red-400"
          )}
        >
          {result.message}
        </span>
      )}
    </div>
  );
}

function sendCommand(command: string, target: string) {
  fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, target, source: "workstream-app" }),
  }).catch(() => {});
}

function PRCard({ instance }: { instance: InstanceWithMetadata }) {
  const [expanded, setExpanded] = useState(false);
  const pr = instance.prStatus!;
  const checks = pr.checks;
  const claudeStatus = getClaudeStatusLabel(instance);
  const branch = instance.gitInfo?.branch ?? instance.branch;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card transition-colors",
        expanded && "ring-1 ring-ring"
      )}
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 flex-shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-primary"
                  >
                    <span className="text-muted-foreground">#{pr.number}</span>
                    <span className="truncate">{pr.title}</span>
                    <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 group-hover:opacity-100" />
                  </a>
                </div>
              </div>

              <div className="flex flex-shrink-0 items-center gap-2">
                <ActionButton
                  label="Fix PR"
                  icon={Wrench}
                  onClick={() => sendCommand("/fix-pr", instance.path)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {branch && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3" />
                  {branch}
                </span>
              )}

              {checks && <ChecksConclusionBadge conclusion={checks.conclusion} />}

              {checks && (
                <span className="text-xs text-muted-foreground">
                  {checks.passing}/{checks.total} passing
                </span>
              )}

              <MergeableBadge mergeable={pr.mergeable} />

              <ClaudeStatusBadge status={claudeStatus} />
            </div>
          </div>
        </div>
      </div>

      {expanded && checks?.runs && checks.runs.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">
            Check Runs
          </h4>
          <div className="space-y-1">
            {checks.runs.map((run) => {
              const bucketConfig = {
                pass: { icon: CheckCircle, className: "text-green-400" },
                fail: { icon: XCircle, className: "text-red-400" },
                pending: { icon: Clock, className: "text-yellow-400" },
                cancel: { icon: Ban, className: "text-zinc-400" },
                skipping: { icon: Ban, className: "text-zinc-400" },
              };
              const cfg = bucketConfig[run.bucket] ?? bucketConfig.pending;
              const RunIcon = cfg.icon;

              return (
                <div
                  key={run.name}
                  className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                >
                  <RunIcon className={cn("h-3.5 w-3.5 flex-shrink-0", cfg.className)} />
                  <span className="truncate text-foreground">{run.name}</span>
                  <span className="ml-auto flex-shrink-0 text-muted-foreground">
                    {run.state}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NoPRCard({ instance }: { instance: InstanceWithMetadata }) {
  const claudeStatus = getClaudeStatusLabel(instance);
  const branch = instance.gitInfo?.branch ?? instance.branch;

  return (
    <div className="rounded-lg border border-dashed border-border bg-card/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {instance.name}
            </h3>
            <span className="text-xs text-muted-foreground">No PR</span>
            <ClaudeStatusBadge status={claudeStatus} />
          </div>
          {branch && (
            <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              {branch}
            </span>
          )}
        </div>

        <ActionButton
          label="Create PR & Fix"
          icon={Plus}
          variant="primary"
          onClick={() => sendCommand("/create-pr-and-fix", instance.path)}
        />
      </div>
    </div>
  );
}

export function PRsPage() {
  const { instances, connected } = useInstances();

  const { withPR, withoutPR, failingCount, pendingCount, passingCount } =
    useMemo(() => {
      const withPR: InstanceWithMetadata[] = [];
      const withoutPR: InstanceWithMetadata[] = [];
      let failing = 0;
      let pending = 0;
      let passing = 0;

      for (const inst of instances) {
        if (inst.prStatus) {
          withPR.push(inst);
          const conclusion = inst.prStatus.checks?.conclusion;
          if (conclusion === "failure") failing++;
          else if (conclusion === "pending") pending++;
          else if (conclusion === "success") passing++;
        } else {
          withoutPR.push(inst);
        }
      }

      // Sort: failing first, then pending, then passing
      const conclusionOrder: Record<string, number> = {
        failure: 0,
        pending: 1,
        success: 2,
      };
      withPR.sort((a, b) => {
        const aOrder = conclusionOrder[a.prStatus?.checks?.conclusion ?? "success"] ?? 2;
        const bOrder = conclusionOrder[b.prStatus?.checks?.conclusion ?? "success"] ?? 2;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.lastUpdated - a.lastUpdated;
      });

      return {
        withPR,
        withoutPR,
        failingCount: failing,
        pendingCount: pending,
        passingCount: passing,
      };
    }, [instances]);

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <GitPullRequest className="h-12 w-12 animate-pulse" />
        <h2 className="text-xl font-semibold text-foreground">Connecting...</h2>
        <p className="text-sm">Waiting for daemon connection on port 9995</p>
      </div>
    );
  }

  if (withPR.length === 0 && withoutPR.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <GitPullRequest className="h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">No Pull Requests</h2>
        <p className="text-sm">PRs will appear here when instances have open pull requests.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">
          Pull Requests{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({withPR.length})
          </span>
        </h1>
        <div className="flex items-center gap-3 text-xs">
          {failingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-red-400">
              <XCircle className="h-3 w-3" />
              {failingCount} failing
            </span>
          )}
          {pendingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-yellow-400">
              <Clock className="h-3 w-3" />
              {pendingCount} pending
            </span>
          )}
          {passingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-green-400">
              <CheckCircle className="h-3 w-3" />
              {passingCount} passing
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {withPR.map((instance) => (
          <PRCard key={instance.path} instance={instance} />
        ))}
      </div>

      {withoutPR.length > 0 && (
        <>
          <h2 className="pt-4 text-sm font-medium text-muted-foreground">
            Instances Without PR ({withoutPR.length})
          </h2>
          <div className="space-y-2">
            {withoutPR.map((instance) => (
              <NoPRCard key={instance.path} instance={instance} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
