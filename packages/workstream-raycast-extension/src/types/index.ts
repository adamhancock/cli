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

export interface ClaudeSession {
  status: 'working' | 'waiting' | 'idle' | 'finished';
  terminalId?: string;
  terminalPid?: number;
  finishedAt?: number;
}

export interface OpenCodeSessionInfo {
  pid: number;
  sessionId: string | null;
  status: 'working' | 'waiting' | 'idle' | 'error';
  lastActivity: number;
  workStartedAt?: number;
  metrics?: {
    toolsUsed: Record<string, number>;
    filesEdited: number;
    commandsRun: number;
  };
}

export interface OpenCodeStatus {
  sessions?: Record<number, OpenCodeSessionInfo>;  // Keyed by PID
  primarySession?: number;  // PID of most recently active session
  
  // Aggregate/legacy fields
  active: boolean;
  sessionId?: string;
  isWorking: boolean;
  isWaiting?: boolean;
  isIdle?: boolean;
  opencodeFinished?: boolean;
  lastEventTime?: number;
  workStartedAt?: number;
  finishedAt?: number;
  metrics?: {
    toolsUsed: Record<string, number>;
    filesEdited: number;
    commandsRun: number;
  };
}

export interface ClaudeStatus {
  active: boolean;
  pid: number;
  ideName: string;
  isWorking: boolean; // true if Claude is actively processing
  isWaiting?: boolean; // true if Claude is waiting for user input
  claudeFinished?: boolean; // true if Claude completed work and user hasn't switched yet
  lastActivityTime?: Date;
  finishedAt?: number; // timestamp when Claude finished
  terminalId?: string; // Terminal ID where Claude is running
  terminalPid?: number; // Terminal PID where Claude was launched
  vscodePid?: number; // VSCode PID if running in VSCode terminal
  sessions?: Record<string, ClaudeSession>; // Map of PID to session info
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

export interface VSCodeExtensionState {
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

export interface InstanceWithStatus extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  opencodeStatus?: OpenCodeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  spotlightStatus?: SpotlightStatus;
  extensionActive?: boolean;
  extensionState?: VSCodeExtensionState;
  extensionVersion?: string;
  lastUpdated?: number;
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
  worktreeRemoved: boolean;
  error?: string;
}

/**
 * Notion task as parsed from the database
 */
export interface NotionTask {
  id: string;                    // Notion page ID
  taskId: string;                // User-defined ID (e.g., "DEV-42")
  title: string;                 // Task summary/title
  branchName: string;            // Generated branch name (e.g., "DEV-42-fix-login-bug")
  status: string;                // Current status text
  statusGroup: 'to_do' | 'in_progress' | 'complete' | 'unknown';
  type?: string;                 // Task type (Bug, Feature, Check, etc.)
  url: string;                   // Notion page URL
  contentMarkdown?: string;      // Full page content rendered to markdown
}

/**
 * Response from daemon when fetching Notion tasks
 */
export interface NotionTasksResponse {
  success: boolean;
  tasks: NotionTask[];
  error?: string;
}

/**
 * Result from requesting Notion tasks (includes metadata about the request)
 */
export interface NotionTasksResult {
  tasks: NotionTask[];
  error?: string;
  source: 'cache' | 'daemon' | 'timeout' | 'error';
}

/**
 * Request to create a new Notion task
 */
export interface CreateNotionTaskRequest {
  title: string;
  requestId: string;
  timestamp: number;
}

/**
 * Response from creating a Notion task
 */
export interface CreateNotionTaskResponse {
  success: boolean;
  task?: NotionTask;
  error?: string;
  requestId: string;
}

/**
 * CI check status from the daemon
 */
export interface KanbanCiChecks {
  passing: number;
  failing: number;
  pending: number;
  conclusion: 'success' | 'failure' | 'pending';
  runs: Array<{
    name: string;
    state: string;
    bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
  }>;
}

/**
 * PR info from vibe-kanban
 */
export interface KanbanPrInfo {
  number: number;
  url: string;
  status: 'open' | 'merged' | 'closed' | 'unknown';
}

/**
 * PR status enriched by daemon with CI status
 */
export interface KanbanPrStatus {
  number: number;
  state: string;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks?: KanbanCiChecks;
}

/**
 * Kanban task instance from vibe-kanban via Redis
 */
export interface KanbanTaskInstance {
  sourceType: 'vibe-kanban';
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  projectName: string;
  branch?: string;
  repoPath?: string;
  prInfo?: KanbanPrInfo;
  prStatus?: KanbanPrStatus;
  directLink?: string;  // vibe-kanban URL path to open task
  baseUrl?: string;     // Base URL of the vibe-kanban instance (e.g., "http://localhost:3456")
  devctl2Url?: string;  // Caddy subdomain URL for dev server (e.g., "https://feature-auth.dev.localhost")
  updatedAt: string;
}
