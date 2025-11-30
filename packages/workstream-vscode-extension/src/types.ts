export interface VSCodeState {
  workspacePath: string;
  extensionVersion: string;
  vscodeVersion: string;
  vscodePid: number;

  window: {
    focused: boolean;
  };

  terminals: {
    total: number;
    active: number;
    pids: number[];
    names: string[];
    purposes: {
      devServer: number;
      testing: number;
      build: number;
      general: number;
    };
  };

  debug: {
    active: boolean;
    sessionCount: number;
    types: string[];
  };

  fileActivity: {
    lastSave: number;
    savesLast5Min: number;
    activeFile?: string;
    dirtyFileCount: number;
  };

  git: {
    branch?: string;
    lastCheckout?: {
      branch: string;
      timestamp: number;
    };
    lastCommit?: {
      timestamp: number;
    };
  };

  lastUpdated: number;
}

export interface WorkstreamEvent {
  type: string;
  workspacePath: string;
  timestamp: number;
  data: Record<string, any>;
}

export interface TerminalInfo {
  pid?: number;
  name: string;
  shellPath?: string;
  cwd?: string;
  createdAt: number;
  closedAt?: number;
  exitCode?: number;
  isActive: boolean;
  hasBeenInteractedWith: boolean;
  purpose: 'dev-server' | 'testing' | 'build' | 'general';
}

export interface ZshTerminalState {
  terminalId: string;
  pid: number;
  vscodePid: number | null;
  workspace: string;
  cwd: string;
  currentCommand: string;
  shellType: string;
  timestamp: number;
}

export type TerminalPurpose = 'dev-server' | 'testing' | 'build' | 'general';

export interface WorktreeUpdate {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  output?: string;
  error?: string;
  worktreePath?: string;
  repoPath?: string;
  worktreeName?: string;
  timestamp: number;
}
