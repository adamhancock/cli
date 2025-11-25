import { getPublisher, getRedisClient } from './redis-client.ts';
import { REDIS_CHANNELS, REDIS_KEYS, type OpenCodeEvent, type OpenCodeEventType } from './types.ts';

/**
 * Publish an event to the workstream daemon
 */
export async function publishEvent(
  eventType: OpenCodeEventType,
  workspacePath: string | null,
  data: Record<string, any>
): Promise<void> {
  try {
    const publisher = getPublisher();
    const redis = getRedisClient();
    const timestamp = Date.now();

    const event: OpenCodeEvent = {
      timestamp,
      channel: REDIS_CHANNELS.OPENCODE,
      event_type: eventType,
      workspace_path: workspacePath,
      data: JSON.stringify(data),
    };

    // Publish to OpenCode channel
    await publisher.publish(
      REDIS_CHANNELS.OPENCODE,
      JSON.stringify({
        type: eventType,
        timestamp,
        path: workspacePath,
        ...data,
      })
    );

    // Also publish to events:new for event store
    await publisher.publish(
      REDIS_CHANNELS.EVENTS_NEW,
      JSON.stringify({
        timestamp,
        channel: REDIS_CHANNELS.OPENCODE,
        event_type: eventType,
        workspace_path: workspacePath,
        data,
      })
    );

    // For Claude-like events, also publish to Claude channel for compatibility
    if (eventType.includes('session')) {
      const claudeEventType = mapToClaudeEventType(eventType);
      if (claudeEventType) {
        await publisher.publish(
          REDIS_CHANNELS.CLAUDE,
          JSON.stringify({
            type: claudeEventType,
            timestamp,
            path: workspacePath,
            source: 'opencode',
            ...data,
          })
        );
      }
    }
  } catch (error) {
    // Silent fail
  }
}

/**
 * Map OpenCode event types to Claude event types for compatibility
 */
function mapToClaudeEventType(eventType: OpenCodeEventType): string | null {
  const mapping: Record<string, string> = {
    'opencode_session_active': 'work_started',
    'opencode_session_idle': 'work_stopped',
    'opencode_session_compacting': 'compacting_started',
  };
  return mapping[eventType] || null;
}

/**
 * Publish a notification to the workstream daemon
 */
export async function publishNotification(
  title: string,
  message: string,
  type: string,
  style: 'success' | 'failure' | 'info',
  workspacePath?: string
): Promise<void> {
  try {
    const publisher = getPublisher();
    const projectName = workspacePath?.split('/').pop() || 'unknown';

    await publisher.publish(
      REDIS_CHANNELS.NOTIFICATIONS,
      JSON.stringify({
        type,
        title,
        message,
        style,
        timestamp: Date.now(),
        projectPath: workspacePath,
        projectName,
      })
    );
  } catch (error) {
    // Silent fail
  }
}
