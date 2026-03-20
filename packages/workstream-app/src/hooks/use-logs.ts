import { useEffect, useState, useCallback, useRef } from "react";
import { useSocket } from "./use-socket";

export type LogEventType =
  | "work_started"
  | "waiting_for_input"
  | "work_stopped"
  | "compacting_started"
  | "notification";

export interface LogEntry {
  id: string;
  timestamp: number;
  type: LogEventType;
  message: string;
  path?: string;
  metadata?: Record<string, unknown>;
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

const MAX_ENTRIES = 500;

const claudeEventMessage: Record<ClaudeEventData["type"], string> = {
  work_started: "Claude started working",
  waiting_for_input: "Claude is waiting for input",
  work_stopped: "Claude stopped working",
  compacting_started: "Claude is compacting context",
};

let entryCounter = 0;

export function useLogs() {
  const { socket } = useSocket();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onClaudeEvent = (data: ClaudeEventData) => {
      const entry: LogEntry = {
        id: `claude-${data.timestamp}-${data.pid}-${entryCounter++}`,
        timestamp: data.timestamp,
        type: data.type,
        message: claudeEventMessage[data.type],
        path: data.path,
        metadata: {
          pid: data.pid,
          terminalName: data.terminalName,
        },
      };
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    };

    const onNotification = (data: NotificationData) => {
      const entry: LogEntry = {
        id: `notif-${data.timestamp}-${entryCounter++}`,
        timestamp: data.timestamp,
        type: "notification",
        message: `${data.title}: ${data.message}`,
        path: data.path,
        metadata: {
          notificationType: data.type,
        },
      };
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    };

    socket.on("claude-event", onClaudeEvent);
    socket.on("notification", onNotification);

    return () => {
      socket.off("claude-event", onClaudeEvent);
      socket.off("notification", onNotification);
    };
  }, [socket]);

  return { entries, clear };
}
