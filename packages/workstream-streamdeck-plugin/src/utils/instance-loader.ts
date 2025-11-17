import { streamDeck } from '@elgato/streamdeck';
import type { VSCodeInstance, InstancesCache } from '../types';
import { getRedisClient, getSubscriber, REDIS_CHANNELS, REDIS_KEYS } from './redis-client';

/**
 * Loads VSCode instances from Redis
 */
export async function loadInstancesFromRedis(): Promise<InstancesCache> {
  try {
    const client = getRedisClient();

    // Get the list of instance paths
    const paths = await client.smembers(REDIS_KEYS.INSTANCES_LIST);

    if (!paths || paths.length === 0) {
      streamDeck.logger.info('No instances found in Redis');
      return {
        instances: [],
        timestamp: Date.now(),
      };
    }

    streamDeck.logger.info(`Found ${paths.length} instance(s) in Redis`);

    // Load data for each instance
    const instances: VSCodeInstance[] = [];

    for (const path of paths) {
      const key = REDIS_KEYS.instance(path);
      const data = await client.get(key);

      if (data) {
        try {
          const instance = JSON.parse(data) as VSCodeInstance;
          instances.push(instance);
        } catch (err) {
          streamDeck.logger.error(`Failed to parse instance data for ${path}:`, err);
        }
      }
    }

    // Get timestamp
    const timestampStr = await client.get(REDIS_KEYS.TIMESTAMP);
    const timestamp = timestampStr ? parseInt(timestampStr, 10) : Date.now();

    streamDeck.logger.info(`Loaded ${instances.length} instance(s) from Redis`);

    return {
      instances,
      timestamp,
    };
  } catch (error) {
    streamDeck.logger.error('Failed to load instances from Redis:', error);
    return {
      instances: [],
      timestamp: Date.now(),
    };
  }
}

/**
 * Subscribe to real-time instance updates
 */
export async function subscribeToUpdates(
  onUpdate: (cache: InstancesCache) => void
): Promise<void> {
  try {
    const subscriber = getSubscriber();

    // Subscribe to the updates channel
    await subscriber.subscribe(REDIS_CHANNELS.UPDATES);

    streamDeck.logger.info('Subscribed to Redis updates channel');

    // Handle messages
    subscriber.on('message', async (channel, message) => {
      if (channel === REDIS_CHANNELS.UPDATES) {
        streamDeck.logger.debug('Received update notification:', message);

        // Load fresh data from Redis
        const cache = await loadInstancesFromRedis();

        // Notify callback
        onUpdate(cache);
      }
    });
  } catch (error) {
    streamDeck.logger.error('Failed to subscribe to updates:', error);
    throw error;
  }
}

/**
 * Unsubscribe from updates
 */
export async function unsubscribeFromUpdates(): Promise<void> {
  try {
    const subscriber = getSubscriber();
    await subscriber.unsubscribe(REDIS_CHANNELS.UPDATES);
    streamDeck.logger.info('Unsubscribed from Redis updates channel');
  } catch (error) {
    streamDeck.logger.error('Failed to unsubscribe from updates:', error);
  }
}
