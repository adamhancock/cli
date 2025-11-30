import Redis from 'ioredis';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      lazyConnect: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    redisClient.on('error', (err) => {
      console.error('[Redis Error]', err.message);
    });
  }
  return redisClient;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => {});
    redisClient = null;
  }
}
