// ============================================================================
// Redis Channel Definitions (matching workstream-daemon)
// ============================================================================

export const REDIS_CHANNELS = {
  // Workstream daemon channels
  UPDATES: 'workstream:updates',
  REFRESH: 'workstream:refresh',
  CLAUDE: 'workstream:claude',
  NOTIFICATIONS: 'workstream:notifications',
  EVENTS_NEW: 'workstream:events:new',
  
  // OpenCode specific channels
  OPENCODE: 'workstream:opencode',
  OPENCODE_CONTROL: 'workstream:opencode:control',
  OPENCODE_CONTEXT: 'workstream:opencode:context',
} as const;

export const REDIS_KEYS = {
  INSTANCES_LIST: 'workstream:instances:list',
  INSTANCE: (path: string) => `workstream:instance:${Buffer.from(path).toString('base64')}`,
  OPENCODE_SESSION: (sessionId: string) => `workstream:opencode:session:${sessionId}`,
  OPENCODE_ANALYTICS: (workspacePath: string) => `workstream:opencode:analytics:${Buffer.from(workspacePath).toString('base64')}`,
} as const;

// ============================================================================
// Event Types (matching daemon event-store.ts)
// ============================================================================

export interface OpenCodeEvent {
  timestamp: number;
  channel: string;
  event_type: string;
  workspace_path: string | null;
  data: string; // JSON stringified event data
}

// OpenCode specific event types
export type OpenCodeEventType =
  // Session events
  | 'opencode_session_created'
  | 'opencode_session_idle'
  | 'opencode_session_active'
  | 'opencode_session_error'
  | 'opencode_session_compacting'
  | 'opencode_session_status'
  | 'opencode_status_changed'  // Triggers immediate daemon API poll for near real-time updates
  
  // Tool events
  | 'opencode_tool_bash'
  | 'opencode_tool_read'
  | 'opencode_tool_write'
  | 'opencode_tool_edit'
  | 'opencode_tool_custom'
  
  // File events
  | 'opencode_file_edited'
  | 'opencode_file_created'
  | 'opencode_file_deleted'
  
  // Message events
  | 'opencode_message_sent'
  | 'opencode_message_received'
  
  // Safety events
  | 'opencode_safety_warning'
  | 'opencode_safety_blocked'
  
  // Permission events
  | 'opencode_permission_requested'
  
  // Analytics events
  | 'opencode_cost_threshold'
  | 'opencode_time_threshold';

// ============================================================================
// Session Tracking
// ============================================================================

export interface OpenCodeSession {
  sessionId: string;
  workspacePath: string;
  projectName: string;
  startTime: number;
  lastActivity: number;
  status: 'active' | 'idle' | 'compacting' | 'error' | 'finished';
  
  // Metrics
  metrics: {
    toolsUsed: Record<string, number>;
    filesEdited: number;
    commandsRun: number;
    errorsEncountered: number;
    tokensUsed: number;
    estimatedCost: number;
    duration: number;
  };
  
  // Git context
  git?: {
    branch: string;
    isDirty: boolean;
    uncommittedFiles: number;
  };
  
  // Current focus
  currentFile?: string;
  currentTask?: string;
}

// ============================================================================
// Workstream Instance Data (from daemon)
// ============================================================================

export interface WorkstreamInstance {
  path: string;
  name: string;
  gitInfo?: {
    branch: string;
    isDirty: boolean;
    modified: number;
    staged: number;
    untracked: number;
  };
  prStatus?: {
    number: number;
    title: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    checks?: {
      conclusion: 'success' | 'failure' | 'pending';
      passing: number;
      failing: number;
      pending: number;
      runs: Array<{
        name: string;
        state: string;
        bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
      }>;
    };
  };
  claudeStatus?: {
    active: boolean;
    isWorking: boolean;
    isWaiting: boolean;
  };
  caddyHost?: {
    name: string;
    url: string;
  };
  spotlightStatus?: {
    port: number;
    isOnline: boolean;
    errorCount: number;
    traceCount: number;
    logCount: number;
  };
  extensionActive?: boolean;
}

// ============================================================================
// Control Commands (daemon → OpenCode)
// ============================================================================

export type ControlCommand =
  | { type: 'pause'; reason?: string }
  | { type: 'resume' }
  | { type: 'inject_context'; context: string }
  | { type: 'focus_file'; filePath: string }
  | { type: 'run_command'; command: string }
  | { type: 'get_status' }
  | { type: 'terminate'; reason?: string };

// ============================================================================
// Safety Guardrails
// ============================================================================

export interface SafetyRule {
  id: string;
  description: string;
  severity: 'warning' | 'error' | 'block';
  check: (context: SafetyContext) => Promise<SafetyResult>;
}

export interface SafetyContext {
  tool: string;
  args: any;
  workspacePath: string;
  git?: {
    branch: string;
    isDirty: boolean;
  };
  session: OpenCodeSession;
}

export interface SafetyResult {
  passed: boolean;
  message?: string;
  suggestion?: string;
}

// ============================================================================
// Plugin Configuration
// ============================================================================

export interface WorkstreamPluginConfig {
  // Redis connection
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  
  // Feature flags
  features: {
    eventTracking: boolean;
    customTools: boolean;
    contextInjection: boolean;
    safetyGuards: boolean;
    analytics: boolean;
    notifications: boolean;
    biDirectionalControl: boolean;
  };
  
  // Analytics thresholds
  analytics: {
    costThreshold: number; // USD
    timeThreshold: number; // minutes
    errorThreshold: number; // count
  };
  
  // Safety rules
  safety: {
    protectedBranches: string[]; // e.g., ['main', 'master', 'production']
    requireCleanBranch: boolean;
    confirmDestructiveCommands: string[]; // e.g., ['rm -rf', 'drop table']
    maxConcurrentSessions: number;
  };
  
  // Notification preferences
  notifications: {
    onSessionIdle: boolean;
    onError: boolean;
    onCostThreshold: boolean;
    onPRCheckComplete: boolean;
  };
}

// ============================================================================
// Plugin Context Type
// ============================================================================

export interface PluginContext {
  project: any;
  client: any;
  $: any;
  directory: string;
  worktree: string;
}
