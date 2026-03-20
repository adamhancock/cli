import { createHash } from 'crypto';
import type { WorkstreamEvent } from './types.js';
import { REDIS_CHANNELS } from './redis.js';

const DEDUP_MAX = 100;
const DEDUP_WINDOW_MS = 60_000;
const RATE_LIMIT_MS = 1_000;

interface DedupEntry {
  hash: string;
  timestamp: number;
}

const recentHashes: DedupEntry[] = [];
const lastEmitByType = new Map<string, number>();

function eventHash(channel: string, message: string): string {
  return createHash('md5').update(`${channel}:${message}`).digest('hex');
}

function isDuplicate(channel: string, message: string): boolean {
  const now = Date.now();
  // Prune old entries
  while (recentHashes.length > 0 && now - recentHashes[0].timestamp > DEDUP_WINDOW_MS) {
    recentHashes.shift();
  }

  const hash = eventHash(channel, message);
  if (recentHashes.some((e) => e.hash === hash)) {
    return true;
  }

  recentHashes.push({ hash, timestamp: now });
  if (recentHashes.length > DEDUP_MAX) {
    recentHashes.shift();
  }

  return false;
}

function isRateLimited(eventType: string): boolean {
  const now = Date.now();
  const last = lastEmitByType.get(eventType);
  if (last && now - last < RATE_LIMIT_MS) {
    return true;
  }
  lastEmitByType.set(eventType, now);
  return false;
}

function sanitizeContent(text: string): string {
  // Strip XML-like tags that could confuse channel tag parsing
  return text.replace(/<\/?channel[^>]*>/gi, '[channel]');
}

export function mapChannelToEventType(channel: string): WorkstreamEvent['type'] | null {
  if (channel === REDIS_CHANNELS.NOTIFICATIONS) return 'notification';
  if (channel === REDIS_CHANNELS.GITHUB_ALIVE) return 'github';
  if (channel === REDIS_CHANNELS.WORKTREE_UPDATES) return 'worktree';
  if (channel === REDIS_CHANNELS.CHROME_CONSOLE) return 'console_error';
  if (channel === REDIS_CHANNELS.VSCODE_GIT) return 'git_change';
  return null;
}

function isRelevantToWorkspace(data: Record<string, unknown>, workspacePath: string): boolean {
  // If no workspace field, it's a broadcast event
  if (!data.workspace && !data.path) return true;
  const eventWorkspace = (data.workspace || data.path) as string;
  return eventWorkspace === workspacePath || workspacePath.startsWith(eventWorkspace) || eventWorkspace.startsWith(workspacePath);
}

function isClaudeActivityNotification(data: Record<string, unknown>): boolean {
  const source = data.source as string | undefined;
  if (source === 'claude-channel') return true;

  const title = ((data.title as string) || '').toLowerCase();
  const message = ((data.message as string) || '').toLowerCase();
  const combined = `${title} ${message}`;

  return (
    combined.includes('claude finished working') ||
    combined.includes('claude started working') ||
    combined.includes('claude code:') ||
    combined.includes('waiting for input')
  );
}

function shouldForwardConsoleEvent(data: Record<string, unknown>): boolean {
  return data.level === 'error';
}

function shouldForwardGitEvent(data: Record<string, unknown>): boolean {
  const eventType = data.type as string | undefined;
  return eventType === 'branch_switch' || eventType === 'merge_conflict' || eventType === 'branch-switch' || eventType === 'merge-conflict';
}

export interface FormattedEvent {
  type: string;
  attributes: Record<string, string>;
  content: string;
}

export function filterAndFormat(
  channel: string,
  rawMessage: string,
  workspacePath: string,
): FormattedEvent | null {
  // Dedup
  if (isDuplicate(channel, rawMessage)) return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawMessage);
  } catch {
    return null;
  }

  const eventType = mapChannelToEventType(channel);
  if (!eventType) return null;

  // Filter out Claude's own activity notifications to prevent feedback loops
  if (eventType === 'notification' && isClaudeActivityNotification(data)) return null;

  // Rate limit
  if (isRateLimited(eventType)) return null;

  // Workspace relevance
  if (!isRelevantToWorkspace(data, workspacePath)) return null;

  // Type-specific filtering
  if (eventType === 'console_error' && !shouldForwardConsoleEvent(data)) return null;
  if (eventType === 'git_change' && !shouldForwardGitEvent(data)) return null;

  // Format content
  const content = formatEventContent(eventType, data);
  if (!content) return null;

  const attributes: Record<string, string> = {
    source: 'workstream',
    type: eventType,
  };

  if (data.timestamp) attributes.timestamp = String(data.timestamp);

  return { type: eventType, attributes, content: sanitizeContent(content) };
}

function formatEventContent(type: string, data: Record<string, unknown>): string | null {
  switch (type) {
    case 'notification': {
      const title = data.title as string || 'Notification';
      const message = data.message as string || '';
      const style = data.style as string;
      return style ? `[${style}] ${title}: ${message}` : `${title}: ${message}`;
    }
    case 'github': {
      const action = data.action as string || data.type as string || 'update';
      const repo = data.repo as string || data.repository as string || '';
      const title = data.title as string || data.message as string || '';
      return `GitHub ${action}${repo ? ` in ${repo}` : ''}: ${title}`;
    }
    case 'worktree': {
      const status = data.status as string || data.type as string || 'update';
      const name = data.name as string || data.worktree as string || '';
      const message = data.message as string || '';
      return `Worktree ${name} ${status}${message ? `: ${message}` : ''}`;
    }
    case 'console_error': {
      const url = data.url as string || data.origin as string || 'unknown';
      const args = data.args as string[] | undefined;
      const message = args ? args.join(' ') : (data.message as string || 'Unknown error');
      return `Console error at ${url}: ${message}`;
    }
    case 'git_change': {
      const eventType = data.type as string || 'change';
      const branch = data.branch as string || data.ref as string || '';
      const message = data.message as string || '';
      if (eventType.includes('branch')) return `Branch switched to: ${branch}`;
      if (eventType.includes('merge')) return `Merge conflict detected${branch ? ` on ${branch}` : ''}: ${message}`;
      return `Git ${eventType}: ${message || branch}`;
    }
    default:
      return null;
  }
}
