import { useEffect, useState, useCallback } from "react";
import { useSocket } from "./use-socket";

export interface GitInfo {
  branch: string;
  isDirty: boolean;
  modified: number;
  staged: number;
  untracked: number;
  ahead?: number;
  behind?: number;
}

export interface PRChecks {
  passing: number;
  failing: number;
  pending: number;
  total: number;
  conclusion: "success" | "failure" | "pending";
}

export interface PRStatus {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks?: PRChecks;
}

export interface ClaudeSession {
  pid: number;
  status: "working" | "waiting" | "idle" | "finished" | "checking" | "compacting";
  terminalName?: string;
  lastActivity: number;
  workStartedAt?: number;
}

export interface ClaudeStatus {
  sessions: Record<number, ClaudeSession>;
  primarySession?: number;
  active: boolean;
  isWorking: boolean;
  isWaiting?: boolean;
  isCompacting?: boolean;
}

export interface InstanceWithMetadata {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: { name: string; exists: boolean };
  lastUpdated: number;
}

interface ClaudeEventData {
  path: string;
  type: "work_started" | "waiting_for_input" | "work_stopped" | "compacting_started";
  pid: number;
  terminalName?: string;
  timestamp: number;
}

export function useInstances() {
  const { socket, connected } = useSocket();
  const [instances, setInstances] = useState<InstanceWithMetadata[]>([]);

  const updateInstance = useCallback((updated: InstanceWithMetadata) => {
    setInstances((prev) => {
      const idx = prev.findIndex((i) => i.path === updated.path);
      if (idx === -1) return [...prev, updated];
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onInstances = (data: InstanceWithMetadata[]) => {
      setInstances(data);
    };

    const onInstanceUpdated = (data: InstanceWithMetadata) => {
      updateInstance(data);
    };

    const onClaudeEvent = (data: ClaudeEventData) => {
      setInstances((prev) =>
        prev.map((inst) => {
          if (inst.path !== data.path) return inst;

          const sessions = { ...(inst.claudeStatus?.sessions ?? {}) };
          const statusMap: Record<ClaudeEventData["type"], ClaudeSession["status"]> = {
            work_started: "working",
            waiting_for_input: "waiting",
            work_stopped: "idle",
            compacting_started: "compacting",
          };

          sessions[data.pid] = {
            pid: data.pid,
            status: statusMap[data.type],
            terminalName: data.terminalName,
            lastActivity: data.timestamp,
            workStartedAt:
              data.type === "work_started" ? data.timestamp : sessions[data.pid]?.workStartedAt,
          };

          const sessionValues = Object.values(sessions);
          const isWorking = sessionValues.some((s) => s.status === "working");
          const isWaiting = sessionValues.some((s) => s.status === "waiting");
          const isCompacting = sessionValues.some((s) => s.status === "compacting");

          return {
            ...inst,
            claudeStatus: {
              ...inst.claudeStatus,
              sessions,
              primarySession: inst.claudeStatus?.primarySession,
              active: isWorking || isWaiting || isCompacting,
              isWorking,
              isWaiting,
              isCompacting,
            },
            lastUpdated: data.timestamp,
          };
        })
      );
    };

    socket.on("instances", onInstances);
    socket.on("instance-updated", onInstanceUpdated);
    socket.on("claude-event", onClaudeEvent);

    if (connected) {
      socket.emit("subscribe");
    }

    return () => {
      socket.off("instances", onInstances);
      socket.off("instance-updated", onInstanceUpdated);
      socket.off("claude-event", onClaudeEvent);
    };
  }, [socket, connected, updateInstance]);

  return { instances, connected };
}
