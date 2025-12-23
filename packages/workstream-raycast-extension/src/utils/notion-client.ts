import Redis from 'ioredis';
import {
  getRedisClient,
  getPublisherClient,
  isRedisAvailable,
  REDIS_KEYS,
  REDIS_CHANNELS,
} from './redis-client';
import type { NotionTask, NotionTasksResponse } from '../types';

/**
 * Get cached Notion tasks directly from Redis
 * Returns null if no cached data or Redis unavailable
 */
export async function getCachedNotionTasks(): Promise<NotionTask[] | null> {
  try {
    if (!(await isRedisAvailable())) {
      return null;
    }

    const redis = getRedisClient();
    const cached = await redis.get(REDIS_KEYS.NOTION_TASKS);

    if (!cached) {
      return null;
    }

    return JSON.parse(cached) as NotionTask[];
  } catch (error) {
    console.error('Failed to get cached Notion tasks:', error);
    return null;
  }
}

/**
 * Request Notion tasks from the daemon via Redis pub/sub
 * The daemon will fetch from Notion API and respond on the response channel
 * Returns tasks if successful, empty array if failed
 */
export async function requestNotionTasks(timeoutMs = 10000): Promise<NotionTask[]> {
  return new Promise(async (resolve) => {
    let subscriber: Redis | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (subscriber) {
        subscriber.unsubscribe().catch(() => {});
        subscriber.quit().catch(() => {});
        subscriber = null;
      }
    };

    const resolveOnce = (tasks: NotionTask[]) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(tasks);
      }
    };

    try {
      if (!(await isRedisAvailable())) {
        console.log('Redis not available, cannot request Notion tasks');
        resolveOnce([]);
        return;
      }

      // First try cached data
      const cached = await getCachedNotionTasks();
      if (cached && cached.length > 0) {
        console.log(`Found ${cached.length} cached Notion tasks`);
        resolveOnce(cached);
        return;
      }

      // Set up subscriber to listen for response
      subscriber = new Redis({
        host: 'localhost',
        port: 6379,
        lazyConnect: false,
        retryStrategy: () => null, // Don't retry
        connectTimeout: 2000,
      });

      subscriber.on('error', (error) => {
        console.error('Notion subscriber error:', error.message);
        resolveOnce([]);
      });

      subscriber.on('message', (channel, message) => {
        if (channel === REDIS_CHANNELS.NOTION_TASKS_RESPONSE) {
          try {
            const response: NotionTasksResponse = JSON.parse(message);
            if (response.success) {
              console.log(`Received ${response.tasks.length} Notion tasks from daemon`);
              resolveOnce(response.tasks);
            } else {
              console.error('Daemon returned error:', response.error);
              resolveOnce([]);
            }
          } catch (error) {
            console.error('Failed to parse Notion response:', error);
            resolveOnce([]);
          }
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.NOTION_TASKS_RESPONSE);

      // Publish request to daemon
      const publisher = getPublisherClient();
      await publisher.publish(
        REDIS_CHANNELS.NOTION_TASKS_REQUEST,
        JSON.stringify({ type: 'fetch_tasks', timestamp: Date.now() })
      );

      console.log('Published Notion tasks request to daemon');

      // Set timeout
      timeoutId = setTimeout(() => {
        console.log('Notion tasks request timed out');
        resolveOnce([]);
      }, timeoutMs);
    } catch (error) {
      console.error('Failed to request Notion tasks:', error);
      resolveOnce([]);
    }
  });
}

/**
 * Refresh Notion tasks from the daemon (force fetch from API)
 * Clears cache first to ensure fresh data
 */
export async function refreshNotionTasks(): Promise<NotionTask[]> {
  try {
    if (!(await isRedisAvailable())) {
      return [];
    }

    // Clear cached data to force fresh fetch
    const redis = getRedisClient();
    await redis.del(REDIS_KEYS.NOTION_TASKS);

    // Request fresh data
    return await requestNotionTasks();
  } catch (error) {
    console.error('Failed to refresh Notion tasks:', error);
    return [];
  }
}

/**
 * Update a Notion task's status via the daemon
 * Returns true if successful
 */
export async function updateNotionTaskStatus(
  pageId: string,
  statusName: string = 'In Progress'
): Promise<{ success: boolean; error?: string }> {
  return new Promise(async (resolve) => {
    let subscriber: Redis | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;
    const requestId = `status-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (subscriber) {
        subscriber.unsubscribe().catch(() => {});
        subscriber.quit().catch(() => {});
        subscriber = null;
      }
    };

    const resolveOnce = (result: { success: boolean; error?: string }) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    try {
      if (!(await isRedisAvailable())) {
        console.log('Redis not available, cannot update Notion status');
        resolveOnce({ success: false, error: 'Redis not available' });
        return;
      }

      // Set up subscriber to listen for response
      subscriber = new Redis({
        host: 'localhost',
        port: 6379,
        lazyConnect: false,
        retryStrategy: () => null,
        connectTimeout: 2000,
      });

      subscriber.on('error', (error) => {
        console.error('Notion status subscriber error:', error.message);
        resolveOnce({ success: false, error: error.message });
      });

      subscriber.on('message', (channel, message) => {
        if (channel === REDIS_CHANNELS.NOTION_UPDATE_STATUS_RESPONSE) {
          try {
            const response = JSON.parse(message);
            // Only handle responses for our request
            if (response.requestId === requestId) {
              if (response.success) {
                console.log(`Notion task ${pageId} status updated to "${statusName}"`);
                resolveOnce({ success: true });
              } else {
                console.error('Daemon returned error:', response.error);
                resolveOnce({ success: false, error: response.error });
              }
            }
          } catch (error) {
            console.error('Failed to parse Notion status response:', error);
            resolveOnce({ success: false, error: 'Failed to parse response' });
          }
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.NOTION_UPDATE_STATUS_RESPONSE);

      // Publish request to daemon
      const publisher = getPublisherClient();
      await publisher.publish(
        REDIS_CHANNELS.NOTION_UPDATE_STATUS_REQUEST,
        JSON.stringify({ pageId, statusName, requestId, timestamp: Date.now() })
      );

      console.log(`Published Notion status update request: ${pageId} -> ${statusName}`);

      // Set timeout
      timeoutId = setTimeout(() => {
        console.log('Notion status update request timed out');
        resolveOnce({ success: false, error: 'Request timed out' });
      }, 10000);
    } catch (error) {
      console.error('Failed to update Notion task status:', error);
      resolveOnce({ success: false, error: String(error) });
    }
  });
}
