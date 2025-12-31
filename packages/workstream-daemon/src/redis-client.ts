import Redis from 'ioredis';

// Redis keys and channels
export const REDIS_KEYS = {
  INSTANCES_LIST: 'workstream:instances:list',
  INSTANCE: (path: string) => `workstream:instance:${Buffer.from(path).toString('base64')}`,
  TIMESTAMP: 'workstream:timestamp',
  CHROME_WINDOWS: 'workstream:chrome:windows',
  DAEMON_LOCK: 'workstream:daemon:lock',
  EVENTS_RECENT: 'workstream:events:recent',
  WORKTREE_JOB: (jobId: string) => `workstream:worktree:job:${jobId}`,
  WORKTREE_LOCK: (repoPath: string, worktreeName: string) =>
    `workstream:worktree:lock:${Buffer.from(repoPath).toString('base64')}:${worktreeName}`,
  // OpenCode uses pattern-based keys for multiple instances:
  // workstream:opencode:instances:{base64(path)} - Set of PIDs
  // workstream:opencode:api:{base64(path)}:{pid} - Instance info

  // Chrome extension keys (separate keys per domain with 24h TTL)
  CHROME_COOKIES: (domain: string) => `workstream:chrome:cookies:${domain}`,
  CHROME_REQUESTS: (domain: string, port: string | number) => `workstream:chrome:requests:${domain}:${port}`,
  CHROME_LOCALSTORAGE: (origin: string) => `workstream:chrome:localstorage:${encodeURIComponent(origin)}`,
  CHROME_CONSOLE: (origin: string) => `workstream:chrome:console:${encodeURIComponent(origin)}`,
  CHROME_CONFIG: 'workstream:chrome:config',           // Hash: extension config

  // Notion integration keys
  NOTION_TASKS: 'workstream:notion:tasks',             // Cached Notion tasks
  NOTION_CONFIG: 'workstream:notion:config',           // Notion configuration
} as const;

export const REDIS_CHANNELS = {
  UPDATES: 'workstream:updates',
  REFRESH: 'workstream:refresh',
  CLAUDE: 'workstream:claude',
  CHROME_UPDATES: 'workstream:chrome:updates',
  NOTIFICATIONS: 'workstream:notifications',
  VSCODE_HEARTBEAT: 'workstream:vscode:heartbeat',
  VSCODE_WORKSPACE: 'workstream:vscode:workspace',
  VSCODE_FILE: 'workstream:vscode:file',
  VSCODE_GIT: 'workstream:vscode:git',
  VSCODE_TERMINAL: 'workstream:vscode:terminal',
  EVENTS_NEW: 'workstream:events:new',
  WORKTREE_JOBS: 'workstream:worktree:jobs',
  WORKTREE_UPDATES: 'workstream:worktree:updates',
  OPENCODE: 'workstream:opencode',
  CHROME_COOKIES: 'workstream:chrome:cookies',
  CHROME_REQUESTS: 'workstream:chrome:requests',
  CHROME_LOCALSTORAGE: 'workstream:chrome:localstorage',
  CHROME_CONSOLE: 'workstream:chrome:console',

  // Notion integration channels
  NOTION_TASKS_REQUEST: 'workstream:notion:tasks:request',
  NOTION_TASKS_RESPONSE: 'workstream:notion:tasks:response',
  NOTION_UPDATE_STATUS_REQUEST: 'workstream:notion:status:request',
  NOTION_UPDATE_STATUS_RESPONSE: 'workstream:notion:status:response',
  NOTION_CREATE_TASK_REQUEST: 'workstream:notion:task:create:request',
  NOTION_CREATE_TASK_RESPONSE: 'workstream:notion:task:create:response',
} as const;

// TTL for instance data (30 seconds - auto-expires if daemon stops)
export const INSTANCE_TTL = 30;

// TTL for Chrome extension data (30 minutes)
export const CHROME_DATA_TTL = 30 * 60;

// TTL for Notion tasks cache (5 minutes)
export const NOTION_TASKS_TTL = 5 * 60;

let redisClient: Redis | null = null;
let publisherClient: Redis | null = null;

/**
 * Get the main Redis client (for data operations)
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    redisClient.on('error', (err) => {
      console.error('[Redis Client Error]', err);
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected to Redis server');
    });
  }
  return redisClient;
}

/**
 * Get the publisher Redis client (separate client for pub/sub)
 */
export function getPublisherClient(): Redis {
  if (!publisherClient) {
    publisherClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    publisherClient.on('error', (err) => {
      console.error('[Redis Publisher Error]', err);
    });
  }
  return publisherClient;
}

/**
 * Close all Redis connections
 */
export async function closeRedisConnections(): Promise<void> {
  const promises: Promise<unknown>[] = [];

  if (redisClient) {
    promises.push(redisClient.quit().catch(() => {}));
    redisClient = null;
  }

  if (publisherClient) {
    promises.push(publisherClient.quit().catch(() => {}));
    publisherClient = null;
  }

  await Promise.all(promises);
}
