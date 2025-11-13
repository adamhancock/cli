import Redis from 'ioredis';

// Redis keys and channels (must match daemon)
export const REDIS_KEYS = {
  INSTANCES_LIST: 'workstream:instances:list',
  INSTANCE: (path: string) => `workstream:instance:${Buffer.from(path).toString('base64')}`,
  TIMESTAMP: 'workstream:timestamp',
} as const;

export const REDIS_CHANNELS = {
  UPDATES: 'workstream:updates',
  REFRESH: 'workstream:refresh',
  CLAUDE: 'workstream:claude',
  NOTIFICATIONS: 'workstream:notifications',
} as const;

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
        // Limit retries in Raycast to fail fast
        if (times > 3) {
          return null; // Stop retrying
        }
        return Math.min(times * 50, 500);
      },
      maxRetriesPerRequest: 2,
      connectTimeout: 1000, // 1 second timeout
    });

    redisClient.on('error', (err) => {
      console.error('[Redis Client Error]', err.message);
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected');
    });
  }
  return redisClient;
}

/**
 * Get the publisher Redis client (for publishing commands)
 */
export function getPublisherClient(): Redis {
  if (!publisherClient) {
    publisherClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => {
        if (times > 3) {
          return null;
        }
        return Math.min(times * 50, 500);
      },
      connectTimeout: 1000,
    });

    publisherClient.on('error', (err) => {
      console.error('[Redis Publisher Error]', err.message);
    });
  }
  return publisherClient;
}

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = getRedisClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
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
