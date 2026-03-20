import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ScrollText, Trash2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogs, type LogEventType, type LogEntry } from "@/hooks/use-logs";
import { useInstances } from "@/hooks/use-instances";

const EVENT_TYPE_STYLES: Record<LogEventType, { bg: string; text: string; label: string }> = {
  work_started: {
    bg: "bg-blue-500/20 border-blue-500/30",
    text: "text-blue-400",
    label: "STARTED",
  },
  waiting_for_input: {
    bg: "bg-yellow-500/20 border-yellow-500/30",
    text: "text-yellow-400",
    label: "WAITING",
  },
  work_stopped: {
    bg: "bg-zinc-500/20 border-zinc-500/30",
    text: "text-zinc-400",
    label: "STOPPED",
  },
  compacting_started: {
    bg: "bg-purple-500/20 border-purple-500/30",
    text: "text-purple-400",
    label: "COMPACT",
  },
  notification: {
    bg: "bg-cyan-500/20 border-cyan-500/30",
    text: "text-cyan-400",
    label: "NOTIFY",
  },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pathToName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function TypeBadge({ type }: { type: LogEventType }) {
  const style = EVENT_TYPE_STYLES[type];
  return (
    <span
      className={cn(
        "inline-flex w-[72px] items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        style.bg,
        style.text
      )}
    >
      {style.label}
    </span>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex items-start gap-3 px-4 py-1.5 font-mono text-xs hover:bg-white/[0.02] transition-colors">
      <span className="shrink-0 text-muted-foreground">{formatTime(entry.timestamp)}</span>
      <TypeBadge type={entry.type} />
      {entry.path && (
        <span className="shrink-0 text-muted-foreground/70 max-w-[120px] truncate" title={entry.path}>
          [{pathToName(entry.path)}]
        </span>
      )}
      <span className="text-foreground break-all">{entry.message}</span>
    </div>
  );
}

export function LogsPage() {
  const { entries, clear } = useLogs();
  const { instances, connected } = useInstances();

  const [selectedPath, setSelectedPath] = useState<string>("__all__");
  const [enabledTypes, setEnabledTypes] = useState<Set<LogEventType>>(
    new Set<LogEventType>(["work_started", "waiting_for_input", "work_stopped", "compacting_started", "notification"])
  );
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (selectedPath !== "__all__" && e.path !== selectedPath) return false;
      if (!enabledTypes.has(e.type)) return false;
      return true;
    });
  }, [entries, selectedPath, enabledTypes]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredEntries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && userScrolledUp.current) {
      userScrolledUp.current = false;
      setAutoScroll(true);
    } else if (!atBottom && !userScrolledUp.current) {
      userScrolledUp.current = true;
      setAutoScroll(false);
    }
  }, []);

  const toggleType = useCallback((type: LogEventType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const resumeAutoScroll = useCallback(() => {
    userScrolledUp.current = false;
    setAutoScroll(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Unique paths from instances for the dropdown
  const sessionOptions = useMemo(() => {
    return instances.map((inst) => ({
      path: inst.path,
      name: inst.name,
    }));
  }, [instances]);

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
        <ScrollText className="h-12 w-12 animate-pulse" />
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
          <h1 className="text-lg font-semibold text-foreground">Logs</h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {filteredEntries.length} entries
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

        {/* Session selector + filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Session dropdown */}
          <div className="relative">
            <select
              value={selectedPath}
              onChange={(e) => setSelectedPath(e.target.value)}
              className="appearance-none rounded-md border border-input bg-background py-1.5 pl-3 pr-8 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="__all__">All sessions</option>
              {sessionOptions.map((opt) => (
                <option key={opt.path} value={opt.path}>
                  {opt.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          </div>

          {/* Type filter buttons */}
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(EVENT_TYPE_STYLES) as LogEventType[]).map((type) => {
              const style = EVENT_TYPE_STYLES[type];
              const active = enabledTypes.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={cn(
                    "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-all",
                    active
                      ? cn(style.bg, style.text)
                      : "border-border text-muted-foreground/40 opacity-50"
                  )}
                >
                  {style.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Log viewer */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 pt-24 text-muted-foreground">
            <ScrollText className="h-10 w-10" />
            <p className="text-sm">No log entries yet. Events will appear here in real time.</p>
          </div>
        ) : (
          <div className="py-2">
            {filteredEntries.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && (
        <button
          onClick={resumeAutoScroll}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-lg transition-colors hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" />
          Auto-scroll paused -- click to resume
        </button>
      )}
    </div>
  );
}
