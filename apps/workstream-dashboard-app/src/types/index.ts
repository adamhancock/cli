/**
 * Type definitions for Workstream instances
 * These match the types from workstream-daemon
 */

export interface GitInfo {
  branch: string;
  isGitRepo: boolean;
  remoteBranch?: string;
  ahead?: number;
  behind?: number;
  isDirty: boolean;
  modified: number;
  staged: number;
  untracked: number;
}

export interface PRCheck {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
}

export interface PRStatus {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks?: {
    passing: number;
    failing: number;
    pending: number;
    total: number;
    conclusion: 'success' | 'failure' | 'pending';
    runs: PRCheck[];
  };
}

export interface ClaudeSessionInfo {
  pid: number;
  status: 'working' | 'waiting' | 'idle' | 'finished' | 'checking' | 'compacting';
  terminalName?: string;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  lastActivity: number;
  workStartedAt?: number;
  finishedAt?: number;
}

export interface ClaudeStatus {
  sessions: Record<number, ClaudeSessionInfo>;
  primarySession?: number;

  // Legacy fields for backwards compatibility
  active: boolean;
  pid: number;
  isWorking: boolean;
  isWaiting?: boolean;
  isChecking?: boolean;
  isCompacting?: boolean;
  claudeFinished?: boolean;
  lastEventTime?: number;
  workStartedAt?: number;
  finishedAt?: number;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
}

export interface TmuxStatus {
  name: string;
  exists: boolean;
}

export interface CaddyHost {
  name: string;
  url: string;
  upstreams?: string[];
  worktreePath?: string;
  routes?: unknown[];
  isActive?: boolean;
}

export interface SpotlightStatus {
  port: number;
  isOnline: boolean;
  errorCount: number;
  traceCount: number;
  logCount: number;
  lastChecked: number;
}

export interface Instance {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
  lastUpdated: number;
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  spotlightStatus?: SpotlightStatus;
  prLastUpdated?: number;
}

export interface ClaudeEventData {
  path: string;
  type: 'work_started' | 'waiting_for_input' | 'work_stopped' | 'compacting_started';
  pid?: number;
  terminalName?: string;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  timestamp: number;
}

export interface NotificationData {
  type: string;
  title: string;
  message: string;
  path?: string;
  timestamp: number;
}
