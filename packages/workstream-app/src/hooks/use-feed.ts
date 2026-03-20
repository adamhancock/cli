import { useEffect, useState, useCallback, useRef } from "react";
import { useSocket } from "./use-socket";

export type FeedEventType = "claude" | "notification" | "instance";

export interface FeedEntry {
  id: string;
  timestamp: number;
  type: FeedEventType;
  title: string;
  message: string;
  path?: string;
  actionable: boolean;
  action?: {
    label: string;
    /** "navigate" goes to sessions page; "command" sends a POST to /api/command */
    kind: "navigate" | "command";
    route?: string;
    command?: string;
    target?: string;
  };
}

interface ClaudeEventData {
  path: string;
  type: "work_started" | "waiting_for_input" | "work_stopped" | "compacting_started";
  pid: number;
  terminalName?: string;
  timestamp: number;
}

interface NotificationData {
  type: string;
  title: string;
  message: string;
  path?: string;
  timestamp: number;
}

interface InstanceUpdatedData {
  name: string;
  path: string;
  lastUpdated: number;
  claudeStatus?: {
    active: boolean;
    isWorking: boolean;
    isWaiting?: boolean;
    isCompacting?: boolean;
  };
  prStatus?: {
    number: number;
    state: string;
    checks?: {
      conclusion: string;
    };
  };
  [key: string]: unknown;
}

const MAX_ENTRIES = 200;

let feedCounter = 0;

function pathToName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

const claudeEventTitles: Record<ClaudeEventData["type"], string> = {
  work_started: "Claude Started Working",
  waiting_for_input: "Claude Waiting for Input",
  work_stopped: "Claude Stopped",
  compacting_started: "Claude Compacting",
};

const claudeEventMessages: Record<ClaudeEventData["type"], (name: string) => string> = {
  work_started: (name) => `Claude began working in ${name}`,
  waiting_for_input: (name) => `Claude needs input in ${name}`,
  work_stopped: (name) => `Claude finished in ${name}`,
  compacting_started: (name) => `Claude is compacting context in ${name}`,
};

/** Critical event types that should trigger browser notifications */
function isCriticalEvent(entry: FeedEntry): boolean {
  return entry.actionable;
}

function showBrowserNotification(entry: FeedEntry) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    document.hasFocus()
  ) {
    return;
  }
  try {
    new Notification(entry.title, {
      body: entry.message,
      tag: entry.id,
      icon: "/vite.svg",
    });
  } catch {
    // Notification API may not be available in all contexts
  }
}

export function useFeed() {
  const { socket } = useSocket();
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const permissionRequested = useRef(false);

  // Request notification permission once
  useEffect(() => {
    if (permissionRequested.current) return;
    permissionRequested.current = true;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const addEntry = useCallback((entry: FeedEntry) => {
    setEntries((prev) => {
      const next = [entry, ...prev];
      return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
    });

    if (isCriticalEvent(entry)) {
      showBrowserNotification(entry);
    }
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onClaudeEvent = (data: ClaudeEventData) => {
      const name = pathToName(data.path);
      const isWaiting = data.type === "waiting_for_input";

      const entry: FeedEntry = {
        id: `feed-claude-${data.timestamp}-${data.pid}-${feedCounter++}`,
        timestamp: data.timestamp,
        type: "claude",
        title: claudeEventTitles[data.type],
        message: claudeEventMessages[data.type](name),
        path: data.path,
        actionable: isWaiting,
        action: isWaiting
          ? {
              label: "View Session",
              kind: "navigate",
              route: "/sessions",
            }
          : undefined,
      };
      addEntry(entry);
    };

    const onNotification = (data: NotificationData) => {
      const isCritical =
        data.type === "error" ||
        data.type === "failure" ||
        data.message?.toLowerCase().includes("fail");

      const entry: FeedEntry = {
        id: `feed-notif-${data.timestamp}-${feedCounter++}`,
        timestamp: data.timestamp,
        type: "notification",
        title: data.title,
        message: data.message,
        path: data.path,
        actionable: isCritical,
        action: isCritical
          ? {
              label: "View Session",
              kind: "navigate",
              route: "/sessions",
            }
          : undefined,
      };
      addEntry(entry);
    };

    const onInstanceUpdated = (data: InstanceUpdatedData) => {
      const name = data.name || pathToName(data.path);
      let title = "Instance Updated";
      let message = `${name} was updated`;

      if (data.claudeStatus?.isWaiting) {
        title = "Instance Needs Attention";
        message = `${name} has a session waiting for input`;
      } else if (data.prStatus) {
        const conclusion = data.prStatus.checks?.conclusion;
        if (conclusion === "failure") {
          title = "PR Checks Failed";
          message = `PR #${data.prStatus.number} checks failed in ${name}`;
        } else if (conclusion === "success") {
          title = "PR Checks Passed";
          message = `PR #${data.prStatus.number} checks passed in ${name}`;
        }
      }

      const isActionable =
        data.claudeStatus?.isWaiting === true ||
        data.prStatus?.checks?.conclusion === "failure";

      const entry: FeedEntry = {
        id: `feed-inst-${data.lastUpdated}-${feedCounter++}`,
        timestamp: data.lastUpdated,
        type: "instance",
        title,
        message,
        path: data.path,
        actionable: isActionable,
        action: isActionable
          ? {
              label: data.prStatus?.checks?.conclusion === "failure" ? "Fix PR" : "View Session",
              kind:
                data.prStatus?.checks?.conclusion === "failure" ? "command" : "navigate",
              route:
                data.prStatus?.checks?.conclusion === "failure" ? undefined : "/sessions",
              command:
                data.prStatus?.checks?.conclusion === "failure" ? "/fix-pr" : undefined,
              target:
                data.prStatus?.checks?.conclusion === "failure" ? data.path : undefined,
            }
          : undefined,
      };
      addEntry(entry);
    };

    socket.on("claude-event", onClaudeEvent);
    socket.on("notification", onNotification);
    socket.on("instance-updated", onInstanceUpdated);

    return () => {
      socket.off("claude-event", onClaudeEvent);
      socket.off("notification", onNotification);
      socket.off("instance-updated", onInstanceUpdated);
    };
  }, [socket, addEntry]);

  return { entries, clear };
}
