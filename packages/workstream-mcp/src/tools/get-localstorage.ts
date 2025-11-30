import { getRedisClient } from '../redis-client.js';
import { REDIS_KEYS } from '../types.js';

export interface GetLocalStorageInput {
  origin?: string;
  key?: string;
}

export interface GetLocalStorageOutput {
  storage: Array<{ origin: string; data: Record<string, string> }>;
  origins: string[];
}

export async function getLocalStorage(input: GetLocalStorageInput): Promise<GetLocalStorageOutput> {
  const redis = getRedisClient();

  // Get all origins with localStorage
  const allOrigins = await redis.hkeys(REDIS_KEYS.CHROME_LOCALSTORAGE);

  // Filter origins if a specific origin is requested
  const originsToFetch = input.origin
    ? allOrigins.filter((o) => o.includes(input.origin!) || input.origin!.includes(o))
    : allOrigins;

  if (originsToFetch.length === 0) {
    return { storage: [], origins: allOrigins };
  }

  // Fetch localStorage for matching origins
  const pipeline = redis.pipeline();
  for (const origin of originsToFetch) {
    pipeline.hget(REDIS_KEYS.CHROME_LOCALSTORAGE, origin);
  }

  const results = await pipeline.exec();
  const storage: Array<{ origin: string; data: Record<string, string> }> = [];

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, rawData] = results[i];
      if (err || !rawData) continue;

      try {
        let data: Record<string, string> = JSON.parse(rawData as string);

        // Filter by key if specified
        if (input.key) {
          const filteredData: Record<string, string> = {};
          if (data[input.key] !== undefined) {
            filteredData[input.key] = data[input.key];
          }
          data = filteredData;
        }

        if (Object.keys(data).length > 0) {
          storage.push({ origin: originsToFetch[i], data });
        }
      } catch {
        // Skip invalid data
      }
    }
  }

  return { storage, origins: allOrigins };
}
