/**
 * Types for VSCode instance data from Redis
 */

export interface VSCodeInstance {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  extensionActive?: boolean;
  lastUpdated?: number;
}

export interface GitInfo {
  branch?: string;
  remoteBranch?: string;
  ahead: number;
  behind: number;
  isDirty: boolean;
  modified: number;
  staged: number;
  untracked: number;
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
}

export interface PRStatus {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  hasConflicts?: boolean;
}

export interface ClaudeStatus {
  active: boolean;
  pid?: number;
  isWorking?: boolean;
  isWaiting?: boolean;
  isFinished?: boolean;
  lastActivityTime?: string;
}

export interface InstancesCache {
  instances: VSCodeInstance[];
  timestamp: number;
}
