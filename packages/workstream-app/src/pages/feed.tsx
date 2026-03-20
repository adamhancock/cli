import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Rss,
  Trash2,
  Bot,
  Bell,
  Server,
  ArrowRight,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFeed, type FeedEntry, type FeedEventType } from "@/hooks/use-feed";
import { useSocket } from "@/hooks/use-socket";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function pathToName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/* ------------------------------------------------------------------ */
/*  Type styling / icons                                              */
/* ------------------------------------------------------------------ */

const TYPE_META: Record<
  FeedEventType,
  { bg: string; text: string; border: string; label: string; Icon: typeof Bot }
> = {
  claude: {
    bg: "bg-blue-500/20",
    text: "text-blue-400",
    border: "border-blue-500/30",
    label: "Claude",
    Icon: Bot,
  },
  notification: {
    bg: "bg-cyan-500/20",
    text: "text-cyan-400",
    border: "border-cyan-500/30",
    label: "Notification",
    Icon: Bell,
  },
  instance: {
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    label: "Instance",
    Icon: Server,
  },
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function TypeBadge({ type }: { type: FeedEventType }) {
  const meta = TYPE_META[type];
  const { Icon } = meta;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.bg,
        meta.text,
        meta.border
      )}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function FeedCard({
  entry,
  onAction,
}: {
  entry: FeedEntry;
  onAction: (entry: FeedEntry) => void;
}) {
  return (
    <div
      className={cn(
        "group rounded-lg border border-border bg-card p-4 transition-colors hover:bg-card/80",
        entry.actionable && "border-yellow-500/30"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Left: badge + timestamp */}
        <div className="flex shrink-0 flex-col items-start gap-1.5">
          <TypeBadge type={entry.type} />
          <span className="text-[10px] text-muted-foreground">
            {relativeTime(entry.timestamp)}
          </span>
        </div>

        {/* Center: title + message + workspace */}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{entry.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{entry.message}</p>
          {entry.path && (
            <span className="mt-1 inline-block text-[10px] text-muted-foreground/60">
              {pathToName(entry.path)}
            </span>
          )}
        </div>

        {/* Right: action button */}
        {entry.actionable && entry.action && (
          <button
            onClick={() => onAction(entry)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              entry.action.kind === "command"
                ? "border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
                : "border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
            )}
          >
            {entry.action.kind === "command" ? (
              <Wrench className="h-3 w-3" />
            ) : (
              <ArrowRight className="h-3 w-3" />
            )}
            {entry.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export function FeedPage() {
  const { entries, clear } = useFeed();
  const { connected } = useSocket();
  const navigate = useNavigate();

  const [enabledTypes, setEnabledTypes] = useState<Set<FeedEventType>>(
    new Set<FeedEventType>(["claude", "notification", "instance"])
  );

  const toggleType = useCallback((type: FeedEventType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const filtered = useMemo(
    () => entries.filter((e) => enabledTypes.has(e.type)),
    [entries, enabledTypes]
  );

  const handleAction = useCallback(
    async (entry: FeedEntry) => {
      if (!entry.action) return;

      if (entry.action.kind === "navigate" && entry.action.route) {
        navigate(entry.action.route);
        return;
      }

      if (entry.action.kind === "command" && entry.action.command) {
        try {
          await fetch("/api/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              command: entry.action.command,
              target: entry.action.target,
              source: "workstream-app-feed",
            }),
          });
        } catch {
          // silently fail -- daemon may be unreachable
        }
      }
    },
    [navigate]
  );

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <Rss className="h-12 w-12 animate-pulse" />
        <h2 className="text-xl font-semibold text-foreground">Connecting...</h2>
        <p className="text-sm">Waiting for daemon connection</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-3 border-b border-border p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground">Feed</h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {filtered.length} event{filtered.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={clear}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          </div>
        </div>

        {/* Type filter toggles */}
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TYPE_META) as FeedEventType[]).map((type) => {
            const meta = TYPE_META[type];
            const active = enabledTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={cn(
                  "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-all",
                  active
                    ? cn(meta.bg, meta.text, meta.border)
                    : "border-border text-muted-foreground/40 opacity-50"
                )}
              >
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Feed list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 pt-24 text-muted-foreground">
            <Rss className="h-10 w-10" />
            <p className="text-sm">
              No events yet. Activity will appear here in real time.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2 p-4">
            {filtered.map((entry) => (
              <FeedCard key={entry.id} entry={entry} onAction={handleAction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
