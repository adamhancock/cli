import Redis from 'ioredis';
import {
  getRedisClient,
  isRedisAvailable,
  REDIS_KEYS,
  REDIS_CHANNELS,
} from './redis-client';

export interface WorkstreamEvent {
  id?: number;
  timestamp: number;
  channel: string;
  event_type: string;
  workspace_path: string | null;
  data: string; // JSON string
  created_at?: number;
}

export interface FormattedEvent {
  id?: number;
  timestamp: number;
  channel: string;
  event_type: string;
  workspace_path: string | null;
  workspace_name?: string;
  relative_time: string;
  icon: string;
  title: string;
  subtitle: string;
  color: string;
  data: any; // Parsed JSON
}

/**
 * Load recent events from Redis
 * Returns null if Redis is not available or no events found
 */
export async function loadRecentEvents(limit = 100): Promise<WorkstreamEvent[] | null> {
  try {
    if (!(await isRedisAvailable())) {
      return null;
    }

    const redis = getRedisClient();
    const eventsStr = await redis.get(REDIS_KEYS.EVENTS_RECENT);

    if (!eventsStr) {
      return [];
    }

    const events: WorkstreamEvent[] = JSON.parse(eventsStr);
    return events.slice(0, limit);
  } catch (error) {
    console.error('Failed to load events from Redis:', error);
    return null;
  }
}

/**
 * Format a relative time string
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 1000) {
    return 'just now';
  }

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Get event metadata (icon, color, title)
 */
function getEventMetadata(event: WorkstreamEvent): {
  icon: string;
  color: string;
  title: string;
  subtitle: string;
} {
  const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

  // Map event types to icons and colors
  const metadata = {
    icon: '📝',
    color: '#999999',
    title: event.event_type,
    subtitle: event.channel,
  };

  // Claude events
  if (event.channel === 'workstream:claude') {
    if (event.event_type === 'work_started') {
      metadata.icon = '🟢';
      metadata.color = '#00C853';
      metadata.title = 'Claude started working';
      metadata.subtitle = data.terminalName || data.terminalId || 'Terminal';
    } else if (event.event_type === 'waiting_for_input') {
      metadata.icon = '🟡';
      metadata.color = '#FFD600';
      metadata.title = 'Claude waiting for input';
      metadata.subtitle = data.terminalName || data.terminalId || 'Terminal';
    } else if (event.event_type === 'work_stopped') {
      metadata.icon = '🔴';
      metadata.color = '#D50000';
      metadata.title = 'Claude finished';
      metadata.subtitle = data.terminalName || data.terminalId || 'Terminal';
    }
  }

  // File events
  else if (event.channel === 'workstream:vscode:file') {
    if (event.event_type === 'file-saved') {
      metadata.icon = '💾';
      metadata.color = '#1E88E5';
      metadata.title = `Saved ${data.data?.fileName || 'file'}`;
      metadata.subtitle = data.data?.languageId || 'File';
    } else if (event.event_type === 'file-opened') {
      metadata.icon = '📂';
      metadata.color = '#43A047';
      metadata.title = `Opened ${data.data?.fileName || 'file'}`;
      metadata.subtitle = data.data?.languageId || 'File';
    }
  }

  // Git events
  else if (event.channel === 'workstream:vscode:git') {
    if (event.event_type === 'branch-checkout') {
      metadata.icon = '🔀';
      metadata.color = '#8E24AA';
      metadata.title = `Switched to ${data.data?.to || 'branch'}`;
      metadata.subtitle = `from ${data.data?.from || 'branch'}`;
    } else if (event.event_type === 'commit') {
      metadata.icon = '✅';
      metadata.color = '#00C853';
      metadata.title = 'Committed changes';
      metadata.subtitle = data.data?.commit || 'Git commit';
    }
  }

  // Terminal events
  else if (event.channel === 'workstream:vscode:terminal') {
    if (event.event_type === 'terminal-opened') {
      metadata.icon = '🖥️';
      metadata.color = '#546E7A';
      metadata.title = `Terminal opened: ${data.data?.name || 'Terminal'}`;
      metadata.subtitle = `PID: ${data.data?.pid || 'unknown'}`;
    } else if (event.event_type === 'terminal-closed') {
      metadata.icon = '🗑️';
      metadata.color = '#546E7A';
      metadata.title = `Terminal closed: ${data.data?.name || 'Terminal'}`;
      metadata.subtitle = data.data?.exitCode !== undefined ? `Exit code: ${data.data.exitCode}` : '';
    } else if (event.event_type === 'debug-started') {
      metadata.icon = '🐛';
      metadata.color = '#F57C00';
      metadata.title = 'Debug session started';
      metadata.subtitle = data.data?.type || 'Debug';
    } else if (event.event_type === 'debug-terminated') {
      metadata.icon = '🛑';
      metadata.color = '#F57C00';
      metadata.title = 'Debug session ended';
      metadata.subtitle = data.data?.type || 'Debug';
    }
  }

  // Workspace events
  else if (event.channel === 'workstream:vscode:workspace') {
    if (event.event_type === 'window-state-changed') {
      const focused = data.data?.focused;
      metadata.icon = focused ? '👁️' : '😴';
      metadata.color = focused ? '#1E88E5' : '#999999';
      metadata.title = focused ? 'Window focused' : 'Window unfocused';
      metadata.subtitle = 'VSCode';
    }
  }

  // Notification events
  else if (event.channel === 'workstream:notifications') {
    metadata.icon = '🔔';
    metadata.color = '#FF6F00';
    metadata.title = data.title || 'Notification';
    metadata.subtitle = data.message || '';

    if (data.style === 'success') {
      metadata.icon = '✅';
      metadata.color = '#00C853';
    } else if (data.style === 'failure') {
      metadata.icon = '❌';
      metadata.color = '#D50000';
    }
  }

  // Update events
  else if (event.channel === 'workstream:updates') {
    metadata.icon = '📊';
    metadata.color = '#1E88E5';
    metadata.title = 'Workstream updated';
    metadata.subtitle = `${data.count || 0} instances`;
  }

  // Chrome events
  else if (event.channel === 'workstream:chrome:updates') {
    metadata.icon = '🌐';
    metadata.color = '#43A047';
    metadata.title = 'Chrome updated';
    metadata.subtitle = `${data.windowCount || 0} windows, ${data.tabCount || 0} tabs`;
  }

  return metadata;
}

/**
 * Format a workstream event for display
 */
export function formatEvent(event: WorkstreamEvent): FormattedEvent {
  const metadata = getEventMetadata(event);
  const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

  return {
    ...event,
    workspace_name: event.workspace_path?.split('/').pop() || undefined,
    relative_time: formatRelativeTime(event.timestamp),
    ...metadata,
    data,
  };
}

/**
 * Group events by workspace
 */
export function groupEventsByWorkspace(
  events: FormattedEvent[]
): Map<string, FormattedEvent[]> {
  const grouped = new Map<string, FormattedEvent[]>();

  for (const event of events) {
    const workspace = event.workspace_path || 'Global';
    if (!grouped.has(workspace)) {
      grouped.set(workspace, []);
    }
    grouped.get(workspace)!.push(event);
  }

  return grouped;
}

/**
 * Subscribe to real-time event updates from the daemon via Redis pub/sub
 * Returns a cleanup function to close the connection
 */
export function subscribeToEvents(
  onUpdate: (events: FormattedEvent[]) => void,
  onError?: () => void
): () => void {
  let subscriber: Redis | null = null;
  let isClosing = false;
  let pollingInterval: NodeJS.Timeout | null = null;

  const connect = async () => {
    if (isClosing) return;

    try {
      if (!(await isRedisAvailable())) {
        console.log('Redis not available, cannot subscribe');
        onError?.();
        return;
      }

      subscriber = new Redis({
        host: 'localhost',
        port: 6379,
        lazyConnect: false,
        retryStrategy: (times) => {
          if (isClosing || times > 5) {
            return null;
          }
          return Math.min(times * 1000, 5000);
        },
      });

      subscriber.on('error', (error) => {
        console.error('Redis subscriber error:', error.message);
        if (!isClosing) {
          onError?.();
        }
      });

      subscriber.on('message', async (channel, message) => {
        try {
          if (channel === REDIS_CHANNELS.EVENTS_NEW) {
            // Reload all recent events from Redis snapshot
            const events = await loadRecentEvents();
            if (events) {
              const formatted = events.map(formatEvent);
              console.log(`Received event update: ${formatted.length} events`);
              onUpdate(formatted);
            }
          }
        } catch (error) {
          console.error('Failed to parse event message:', error);
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.EVENTS_NEW);
      console.log('Subscribed to events channel');

      // Load initial data
      const events = await loadRecentEvents();
      if (events) {
        const formatted = events.map(formatEvent);
        onUpdate(formatted);
      }

      // Also poll every 2 seconds as a fallback
      pollingInterval = setInterval(async () => {
        if (isClosing) return;
        const events = await loadRecentEvents();
        if (events) {
          const formatted = events.map(formatEvent);
          onUpdate(formatted);
        }
      }, 2000);
    } catch (error) {
      console.error('Failed to subscribe:', error);
      onError?.();
    }
  };

  // Start initial connection
  connect();

  // Return cleanup function
  return () => {
    isClosing = true;
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    if (subscriber) {
      subscriber.unsubscribe().catch(() => {});
      subscriber.quit().catch(() => {});
      subscriber = null;
    }
  };
}
