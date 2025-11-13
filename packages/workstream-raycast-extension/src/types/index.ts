export interface VSCodeInstance {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
}

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
  lastCommit?: {
    message: string;
    author: string;
    date: string;
  };
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
  author: string;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  labels?: string[];
  checks?: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    conclusion: 'success' | 'failure' | 'pending';
    runs: PRCheck[];
  };
}

export interface ClaudeStatus {
  active: boolean;
  pid: number;
  ideName: string;
  isWorking: boolean; // true if Claude is actively processing
  isWaiting?: boolean; // true if Claude is waiting for user input
  lastActivityTime?: Date;
}

export interface TmuxStatus {
  name: string;
  exists: boolean;
  lastOutput?: string;
}

export interface SpotlightStatus {
  port: number;
  isOnline: boolean;
  errorCount: number;
  traceCount: number;
  logCount: number;
  lastChecked: number;
}

export interface InstanceWithStatus extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  spotlightStatus?: SpotlightStatus;
  error?: string;
}

export interface CaddyHost {
  name: string;
  url: string;
  upstreams?: string[];
  worktreePath?: string;
  routes?: unknown[];
  isActive?: boolean;
}

export interface CaddyConfig {
  apps?: {
    http?: {
      servers?: {
        [key: string]: {
          routes?: Array<{
            match?: Array<{
              host?: string[];
            }>;
            handle?: unknown[];
          }>;
        };
      };
    };
  };
}

export enum CleanupCriteria {
  MergedPRs = 'merged',
  ClosedPRs = 'closed',
  OldWorktrees = 'old',
}

export interface CleanupResult {
  success: boolean;
  instancePath: string;
  instanceName: string;
  vscodeClosed: boolean;
  tmuxClosed: boolean;
  caddyRouteClosed: boolean;
  error?: string;
}
