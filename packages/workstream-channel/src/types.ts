export interface WorkstreamCommand {
  command: string;
  context?: Record<string, unknown>;
  source: string;
  id: string;
}

export interface WorkstreamEvent {
  type: 'notification' | 'github' | 'worktree' | 'console_error' | 'git_change';
  title?: string;
  message?: string;
  workspace?: string;
  level?: string;
  style?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

export interface CommandResult {
  command_id: string;
  status: 'success' | 'error';
  message: string;
  workspace_hash: string;
}

export interface ChannelInstance {
  hash: string;
  workspace: string;
  pid: number;
  started_at: number;
}

export interface ChannelNotification {
  method: 'notifications/claude/channel';
  params: {
    channel: string;
    attributes: Record<string, string>;
    content: string;
  };
}
