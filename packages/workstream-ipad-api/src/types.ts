// Type definitions matching the workstream data structures

export interface VSCodeInstance {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
}

export interface GitInfo {
  branch?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  isDirty?: boolean;
  lastCommit?: {
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
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks?: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    conclusion: 'success' | 'failure' | 'pending' | null;
  };
}

export interface ClaudeSession {
  status: 'working' | 'waiting' | 'idle' | 'finished';
  pid: number;
  terminalName?: string;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  workStartTime?: number;
  finishTime?: number;
  lastActivity?: number;
}

export interface ClaudeStatus {
  sessions: ClaudeSession[];
  hasActiveSessions: boolean;
}

export interface Terminal {
  name: string;
  id: string;
  pid?: number;
  purpose?: 'dev-server' | 'testing' | 'build' | 'general';
}

export interface VSCodeExtensionState {
  workspacePath: string;
  window?: {
    isFocused: boolean;
  };
  terminals?: {
    total: number;
    active: number;
    list: Terminal[];
  };
  debugSessions?: {
    active: boolean;
    count: number;
    types: string[];
  };
  fileActivity?: {
    lastSave?: number;
    savesPerFiveMinutes: number;
    activeFile?: string;
    dirtyFileCount: number;
  };
  gitEvents?: {
    lastCheckout?: { branch: string; timestamp: number };
    lastCommit?: { message: string; timestamp: number };
  };
  timestamp: number;
}

export interface TmuxStatus {
  hasSession: boolean;
  sessionName?: string;
}

export interface CaddyHost {
  host: string;
  url: string;
  upstreams: string[];
}

export interface SpotlightStatus {
  errors: number;
  traces: number;
  logs: number;
  online: boolean;
}

export interface InstanceWithMetadata extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  spotlightStatus?: SpotlightStatus;
  extensionState?: VSCodeExtensionState;
}

export interface InstancesResponse {
  instances: InstanceWithMetadata[];
  timestamp: number;
}

export interface WebSocketMessage {
  type: 'instances' | 'refresh' | 'claude' | 'heartbeat' | 'chrome' | 'notification';
  data?: unknown;
  timestamp: number;
}

export interface ChromeWindow {
  windowId: number;
  title: string;
  url: string;
  tabs: Array<{
    title: string;
    url: string;
  }>;
}
