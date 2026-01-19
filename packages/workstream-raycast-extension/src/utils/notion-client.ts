import Redis from 'ioredis';
import {
  getRedisClient,
  getPublisherClient,
  isRedisAvailable,
  REDIS_KEYS,
  REDIS_CHANNELS,
} from './redis-client';
import type { NotionTask, NotionTasksResponse, NotionTasksResult, CreateNotionTaskResponse } from '../types';

// Track in-flight requests to prevent duplicate daemon calls
let pendingTasksRequest: Promise<NotionTasksResult> | null = null;

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
 * Returns result with tasks and metadata about the request source
 */
export async function requestNotionTasks(timeoutMs = 30000): Promise<NotionTasksResult> {
  // First, always try cache synchronously before anything else
  try {
    if (await isRedisAvailable()) {
      const cached = await getCachedNotionTasks();
      if (cached && cached.length > 0) {
        console.log(`Found ${cached.length} cached Notion tasks`);
        return { tasks: cached, source: 'cache' };
      }
    }
  } catch (e) {
    console.error('Cache check failed:', e);
  }

  // If there's already a pending request, return that instead of making a new one
  if (pendingTasksRequest) {
    console.log('Reusing pending Notion tasks request');
    return pendingTasksRequest;
  }

  // Create the daemon request
  pendingTasksRequest = requestNotionTasksFromDaemon(timeoutMs);

  try {
    return await pendingTasksRequest;
  } finally {
    pendingTasksRequest = null;
  }
}

/**
 * Internal function to request tasks from daemon (no caching/deduplication)
 */
async function requestNotionTasksFromDaemon(timeoutMs: number): Promise<NotionTasksResult> {
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

    const resolveOnce = (result: NotionTasksResult) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    try {
      if (!(await isRedisAvailable())) {
        console.log('Redis not available, cannot request Notion tasks');
        resolveOnce({ tasks: [], error: 'Redis not available', source: 'error' });
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
        resolveOnce({ tasks: [], error: error.message, source: 'error' });
      });

      subscriber.on('message', (channel, message) => {
        if (channel === REDIS_CHANNELS.NOTION_TASKS_RESPONSE) {
          try {
            const response: NotionTasksResponse = JSON.parse(message);
            if (response.success) {
              console.log(`Received ${response.tasks.length} Notion tasks from daemon`);
              resolveOnce({ tasks: response.tasks, source: 'daemon' });
            } else {
              console.error('Daemon returned error:', response.error);
              resolveOnce({ tasks: [], error: response.error, source: 'error' });
            }
          } catch (error) {
            console.error('Failed to parse Notion response:', error);
            resolveOnce({ tasks: [], error: 'Failed to parse response', source: 'error' });
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
        resolveOnce({ tasks: [], error: 'Request timed out - is daemon running?', source: 'timeout' });
      }, timeoutMs);
    } catch (error) {
      console.error('Failed to request Notion tasks:', error);
      resolveOnce({ tasks: [], error: String(error), source: 'error' });
    }
  });
}

/**
 * Refresh Notion tasks from the daemon (force fetch from API)
 * Clears cache first to ensure fresh data
 */
export async function refreshNotionTasks(): Promise<NotionTasksResult> {
  try {
    if (!(await isRedisAvailable())) {
      return { tasks: [], error: 'Redis not available', source: 'error' };
    }

    // Clear cached data to force fresh fetch
    const redis = getRedisClient();
    await redis.del(REDIS_KEYS.NOTION_TASKS);

    // Request fresh data
    return await requestNotionTasks();
  } catch (error) {
    console.error('Failed to refresh Notion tasks:', error);
    return { tasks: [], error: String(error), source: 'error' };
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

/**
 * Create a new Notion task via the daemon
 * Returns the created task if successful
 */
export async function createNotionTask(
  title: string
): Promise<CreateNotionTaskResponse> {
  return new Promise(async (resolve) => {
    let subscriber: Redis | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;
    const requestId = `create-${Date.now()}-${Math.random().toString(36).substring(7)}`;

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

    const resolveOnce = (result: CreateNotionTaskResponse) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    try {
      if (!(await isRedisAvailable())) {
        console.log('Redis not available, cannot create Notion task');
        resolveOnce({ success: false, error: 'Redis not available', requestId });
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
        console.error('Notion create task subscriber error:', error.message);
        resolveOnce({ success: false, error: error.message, requestId });
      });

      subscriber.on('message', (channel, message) => {
        if (channel === REDIS_CHANNELS.NOTION_CREATE_TASK_RESPONSE) {
          try {
            const response: CreateNotionTaskResponse = JSON.parse(message);
            // Only handle responses for our request
            if (response.requestId === requestId) {
              if (response.success && response.task) {
                console.log(`Notion task created: ${response.task.taskId || response.task.id}`);
                resolveOnce(response);
              } else {
                console.error('Daemon returned error:', response.error);
                resolveOnce({ success: false, error: response.error, requestId });
              }
            }
          } catch (error) {
            console.error('Failed to parse Notion create task response:', error);
            resolveOnce({ success: false, error: 'Failed to parse response', requestId });
          }
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.NOTION_CREATE_TASK_RESPONSE);

      // Publish request to daemon
      const publisher = getPublisherClient();
      await publisher.publish(
        REDIS_CHANNELS.NOTION_CREATE_TASK_REQUEST,
        JSON.stringify({ title, requestId, timestamp: Date.now() })
      );

      console.log(`Published Notion create task request: "${title}"`);

      // Set timeout
      timeoutId = setTimeout(() => {
        console.log('Notion create task request timed out');
        resolveOnce({ success: false, error: 'Request timed out', requestId });
      }, 15000); // Longer timeout for creation
    } catch (error) {
      console.error('Failed to create Notion task:', error);
      resolveOnce({ success: false, error: String(error), requestId });
    }
  });
}
