import Redis from 'ioredis';
import type { WorkstreamPluginConfig } from './types.ts';

let redisClient: Redis | null = null;
let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;

/**
 * Initialize Redis connection
 */
export async function initRedis(config: WorkstreamPluginConfig['redis']): Promise<void> {
  if (redisClient) {
    return;
  }

  const redisConfig = {
    host: config.host,
    port: config.port,
    password: config.password,
    lazyConnect: false,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: 3,
  };

  // Main client for data operations
  redisClient = new Redis(redisConfig);
  
  // Separate publisher client for pub/sub
  publisherClient = new Redis(redisConfig);
  
  // Separate subscriber client for receiving commands
  subscriberClient = new Redis(redisConfig);

  // Silent error handling
  redisClient.on('error', () => {});
  publisherClient.on('error', () => {});
  subscriberClient.on('error', () => {});
}

/**
 * Get Redis client for data operations
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('[Workstream] Redis client not initialized. Call initRedis() first.');
  }
  return redisClient;
}

/**
 * Get Redis publisher client
 */
export function getPublisher(): Redis {
  if (!publisherClient) {
    throw new Error('[Workstream] Redis publisher not initialized. Call initRedis() first.');
  }
  return publisherClient;
}

/**
 * Get Redis subscriber client
 */
export function getSubscriber(): Redis {
  if (!subscriberClient) {
    throw new Error('[Workstream] Redis subscriber not initialized. Call initRedis() first.');
  }
  return subscriberClient;
}

/**
 * Close all Redis connections
 */
export async function closeRedis(): Promise<void> {
  const promises: Promise<unknown>[] = [];

  if (redisClient) {
    promises.push(redisClient.quit().catch(() => {}));
    redisClient = null;
  }

  if (publisherClient) {
    promises.push(publisherClient.quit().catch(() => {}));
    publisherClient = null;
  }

  if (subscriberClient) {
    promises.push(subscriberClient.quit().catch(() => {}));
    subscriberClient = null;
  }

  await Promise.all(promises);
}
