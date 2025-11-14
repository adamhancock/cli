import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import Redis from 'ioredis';
import {
  getRedisClient,
  getPublisherClient,
  isRedisAvailable,
  REDIS_KEYS,
  REDIS_CHANNELS,
} from './redis-client';
import type { InstanceWithStatus } from '../types';

const DAEMON_CACHE_FILE = join(homedir(), '.workstream-daemon', 'instances.json');

export interface DaemonCache {
  instances: InstanceWithStatus[];
  timestamp: number;
}

/**
 * Try to load instances from the daemon cache file
 * Returns null if daemon is not running or cache is not available
 */
export async function loadFromDaemon(): Promise<DaemonCache | null> {
  try {
    const content = await readFile(DAEMON_CACHE_FILE, 'utf-8');
    const cache: DaemonCache = JSON.parse(content);

    // Check if cache is recent (within last 10 minutes)
    const age = Date.now() - cache.timestamp;
    if (age > 600000) {
      console.log('Daemon cache is stale, falling back to direct fetch');
      return null;
    }

    console.log(`Loaded ${cache.instances.length} instances from daemon (age: ${age}ms)`);
    return cache;
  } catch (error) {
    // Daemon not running or cache not available
    return null;
  }
}

/**
 * Load instances directly from Redis
 * Returns null if Redis is not available or no data found
 */
export async function loadFromRedis(): Promise<DaemonCache | null> {
  try {
    // Check if Redis is available
    if (!(await isRedisAvailable())) {
      return null;
    }

    const redis = getRedisClient();

    // Get timestamp
    const timestampStr = await redis.get(REDIS_KEYS.TIMESTAMP);
    if (!timestampStr) {
      return null;
    }
    const timestamp = parseInt(timestampStr, 10);

    // Check if data is recent (within last 10 minutes)
    const age = Date.now() - timestamp;
    if (age > 600000) {
      console.log('Redis data is stale');
      return null;
    }

    // Get instance paths
    const paths = await redis.smembers(REDIS_KEYS.INSTANCES_LIST);
    if (!paths || paths.length === 0) {
      return null;
    }

    // Get each instance data
    const pipeline = redis.pipeline();
    for (const path of paths) {
      pipeline.get(REDIS_KEYS.INSTANCE(path));
    }

    const results = await pipeline.exec();
    if (!results) {
      return null;
    }

    const instances: InstanceWithStatus[] = [];
    for (const [err, result] of results) {
      if (!err && result && typeof result === 'string') {
        try {
          instances.push(JSON.parse(result));
        } catch {
          // Skip invalid JSON
        }
      }
    }

    console.log(`Loaded ${instances.length} instances from Redis (age: ${age}ms)`);
    return { instances, timestamp };
  } catch (error) {
    console.error('Failed to load from Redis:', error);
    return null;
  }
}

/**
 * Trigger daemon to refresh instances immediately via Redis pub/sub
 * Returns true if message was sent successfully
 */
export async function triggerDaemonRefresh(): Promise<boolean> {
  try {
    if (!(await isRedisAvailable())) {
      return false;
    }

    const publisher = getPublisherClient();
    await publisher.publish(
      REDIS_CHANNELS.REFRESH,
      JSON.stringify({ type: 'refresh' })
    );

    console.log('Triggered daemon refresh via Redis');
    return true;
  } catch (error) {
    console.error('Failed to trigger refresh:', error);
    return false;
  }
}

/**
 * Clear the Claude finished flag for a specific instance via Redis pub/sub
 * Returns true if message was sent successfully
 */
export async function clearClaudeFinishedFlag(instancePath: string): Promise<boolean> {
  try {
    if (!(await isRedisAvailable())) {
      return false;
    }

    const publisher = getPublisherClient();
    await publisher.publish(
      REDIS_CHANNELS.CLAUDE,
      JSON.stringify({
        type: 'clear_finished',
        path: instancePath
      })
    );

    console.log(`Cleared finished flag for ${instancePath}`);
    return true;
  } catch (error) {
    console.error('Failed to clear finished flag:', error);
    return false;
  }
}

/**
 * Subscribe to real-time updates from the daemon via Redis pub/sub
 * Returns a cleanup function to close the connection
 */
export function subscribeToUpdates(
  onUpdate: (instances: InstanceWithStatus[], timestamp?: number) => void,
  onError?: () => void
): () => void {
  let subscriber: Redis | null = null;
  let isClosing = false;

  const connect = async () => {
    if (isClosing) return;

    try {
      // Check if Redis is available
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
          if (channel === REDIS_CHANNELS.UPDATES) {
            const data = JSON.parse(message);
            if (data.type === 'instances') {
              // Load instances from Redis
              const cache = await loadFromRedis();
              if (cache) {
                console.log(`Received update: ${cache.instances.length} instances`);
                onUpdate(cache.instances, cache.timestamp);
              }
            }
          }
        } catch (error) {
          console.error('Failed to parse Redis message:', error);
        }
      });

      await subscriber.subscribe(REDIS_CHANNELS.UPDATES);
      console.log('Subscribed to Redis updates channel');

      // Load initial data
      const cache = await loadFromRedis();
      if (cache) {
        onUpdate(cache.instances, cache.timestamp);
      }
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
    if (subscriber) {
      subscriber.unsubscribe().catch(() => {});
      subscriber.quit().catch(() => {});
      subscriber = null;
    }
  };
}
