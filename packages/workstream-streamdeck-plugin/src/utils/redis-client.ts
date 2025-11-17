import Redis from 'ioredis';
import { streamDeck } from '@elgato/streamdeck';

/**
 * Redis channel names used by the workstream daemon
 */
export const REDIS_CHANNELS = {
  UPDATES: 'workstream:updates',
  REFRESH: 'workstream:refresh',
  CLAUDE: 'workstream:claude',
  NOTIFICATIONS: 'workstream:notifications',
} as const;

/**
 * Redis keys used by the workstream daemon
 */
export const REDIS_KEYS = {
  INSTANCES_LIST: 'workstream:instances:list',
  TIMESTAMP: 'workstream:timestamp',
  instance: (path: string) => {
    const base64Path = Buffer.from(path).toString('base64');
    return `workstream:instance:${base64Path}`;
  },
} as const;

/**
 * Redis client configuration
 */
const REDIS_CONFIG = {
  host: 'localhost',
  port: 6379,
  retryStrategy: (times: number) => {
    // Retry up to 10 times
    if (times > 10) {
      streamDeck.logger.error('Redis connection failed after 10 retries');
      return null;
    }
    // Exponential backoff: 50ms, 100ms, 200ms, 400ms, etc.
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
};

class RedisClientManager {
  private static instance: RedisClientManager;
  private _publisher: Redis | null = null;
  private _subscriber: Redis | null = null;
  private _client: Redis | null = null;
  private _isConnected = false;

  private constructor() {}

  static getInstance(): RedisClientManager {
    if (!RedisClientManager.instance) {
      RedisClientManager.instance = new RedisClientManager();
    }
    return RedisClientManager.instance;
  }

  async connect(): Promise<void> {
    if (this._isConnected) {
      return;
    }

    try {
      streamDeck.logger.info('Connecting to Redis...');

      // Create clients
      this._client = new Redis(REDIS_CONFIG);
      this._publisher = new Redis(REDIS_CONFIG);
      this._subscriber = new Redis(REDIS_CONFIG);

      // Connect all clients
      await Promise.all([
        this._client.connect(),
        this._publisher.connect(),
        this._subscriber.connect(),
      ]);

      // Set up error handlers
      this._client.on('error', (err) => {
        streamDeck.logger.error('Redis client error:', err);
      });

      this._publisher.on('error', (err) => {
        streamDeck.logger.error('Redis publisher error:', err);
      });

      this._subscriber.on('error', (err) => {
        streamDeck.logger.error('Redis subscriber error:', err);
      });

      this._isConnected = true;
      streamDeck.logger.info('Connected to Redis successfully');
    } catch (error) {
      streamDeck.logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected) {
      return;
    }

    try {
      streamDeck.logger.info('Disconnecting from Redis...');

      await Promise.all([
        this._client?.quit(),
        this._publisher?.quit(),
        this._subscriber?.quit(),
      ]);

      this._client = null;
      this._publisher = null;
      this._subscriber = null;
      this._isConnected = false;

      streamDeck.logger.info('Disconnected from Redis');
    } catch (error) {
      streamDeck.logger.error('Error disconnecting from Redis:', error);
    }
  }

  get client(): Redis {
    if (!this._client || !this._isConnected) {
      throw new Error('Redis client not connected. Call connect() first.');
    }
    return this._client;
  }

  get publisher(): Redis {
    if (!this._publisher || !this._isConnected) {
      throw new Error('Redis publisher not connected. Call connect() first.');
    }
    return this._publisher;
  }

  get subscriber(): Redis {
    if (!this._subscriber || !this._isConnected) {
      throw new Error('Redis subscriber not connected. Call connect() first.');
    }
    return this._subscriber;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }
}

// Export singleton instance
export const redisManager = RedisClientManager.getInstance();

// Convenience exports
export const getRedisClient = () => redisManager.client;
export const getPublisher = () => redisManager.publisher;
export const getSubscriber = () => redisManager.subscriber;
