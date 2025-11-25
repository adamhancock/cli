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
} as const;

// TTL for instance data (30 seconds - auto-expires if daemon stops)
export const INSTANCE_TTL = 30;

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
