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
 * Extract a Notion page ID from a URL
 * Handles formats:
 *   https://notion.so/<id>
 *   https://www.notion.so/workspace/Page-Title-<id>
 *   https://notion.so/<id>?v=...
 *   https://www.notion.so/workspace/Page-Title-<32-char-hex>?...
 */
export function extractNotionPageId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('notion.so') && !parsed.hostname.endsWith('notion.site')) {
      return null;
    }

    // The page ID is the last 32 hex characters in the URL path
    // It may appear as a bare ID or appended to a slug with a hyphen
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return null;

    const lastSegment = pathSegments[pathSegments.length - 1];

    // Try to extract a 32-char hex ID (with or without hyphens)
    // Notion IDs are 32 hex chars, sometimes with hyphens (UUID format)
    const hexMatch = lastSegment.match(/([a-f0-9]{32})$/i)
      || lastSegment.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);

    if (hexMatch) {
      // Return as UUID format
      const hex = hexMatch[1].replace(/-/g, '');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract a branch-name-friendly slug from a Notion URL path
 * e.g. "Email-data-metric-import-for-unsupported-integration-3190556a8a6c80838fcff08369b21720"
 * -> "email-data-metric-import-for-unsupported-integration"
 */
export function extractSlugFromNotionUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return null;

    const lastSegment = pathSegments[pathSegments.length - 1];
    // Remove the trailing 32-char hex ID
    const withoutId = lastSegment.replace(/-?[a-f0-9]{32}$/i, '');
    if (!withoutId) return null;

    return withoutId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single Notion page by URL via the daemon
 */
export async function fetchNotionPageByUrl(
  url: string,
  timeoutMs = 15000
): Promise<{ success: boolean; task?: NotionTask; error?: string }> {
  const pageId = extractNotionPageId(url);
  if (!pageId) {
    return { success: false, error: 'Invalid Notion URL' };
  }

  return new Promise(async (resolve) => {
    let subscriber: Redis | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;
    const requestId = `page-${Date.now()}-${Math.random().toString(36).substring(7)}`;

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

    const resolveOnce = (result: { success: boolean; task?: NotionTask; error?: string }) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    try {
      if (!(await isRedisAvailable())) {
        resolveOnce({ success: false, error: 'Redis not available' });
        return;
      }

      subscriber = new Redis({
        host: 'localhost',
        port: 6379,
        lazyConnect: false,
        retryStrategy: () => null,
        connectTimeout: 2000,
      });

      subscriber.on('error', (error) => {
        resolveOnce({ success: false, error: error.message });
      });

      subscriber.on('message', (channel, message) => {
        if (channel === REDIS_CHANNELS.NOTION_FETCH_PAGE_RESPONSE) {
          try {
            const response = JSON.parse(message);
            if (response.requestId === requestId) {
              if (response.success && response.task) {
                resolveOnce({ success: true, task: response.task });
              } else {
                resolveOnce({ success: false, error: response.error || 'Failed to fetch page' });
              }
            }
          } catch (error) {
            resolveOnce({ success: false, error: 'Failed to parse response' });
          }
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.NOTION_FETCH_PAGE_RESPONSE);

      const publisher = getPublisherClient();
      await publisher.publish(
        REDIS_CHANNELS.NOTION_FETCH_PAGE_REQUEST,
        JSON.stringify({ pageId, requestId, timestamp: Date.now() })
      );

      timeoutId = setTimeout(() => {
        resolveOnce({ success: false, error: 'Request timed out' });
      }, timeoutMs);
    } catch (error) {
      resolveOnce({ success: false, error: String(error) });
    }
  });
}

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
