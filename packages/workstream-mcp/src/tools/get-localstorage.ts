import { getRedisClient } from '../redis-client.js';
import { REDIS_KEY_PATTERNS } from '../types.js';

export interface GetLocalStorageInput {
  origin?: string;
  key?: string;
}

export interface GetLocalStorageOutput {
  storage: Array<{ origin: string; data: Record<string, string> }>;
  origins: string[];
}

// Extract origin from key like "workstream:chrome:localstorage:http%3A%2F%2Fexample.com"
function extractOriginFromKey(key: string): string {
  const prefix = 'workstream:chrome:localstorage:';
  const encoded = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export async function getLocalStorage(input: GetLocalStorageInput): Promise<GetLocalStorageOutput> {
  const redis = getRedisClient();

  // Scan for all localStorage keys
  const allKeys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', REDIS_KEY_PATTERNS.CHROME_LOCALSTORAGE, 'COUNT', 100);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== '0');

  const allOrigins = allKeys.map(extractOriginFromKey);

  // Filter keys if a specific origin is requested
  const keysToFetch = input.origin
    ? allKeys.filter((key) => {
        const origin = extractOriginFromKey(key);
        return origin.includes(input.origin!) || input.origin!.includes(origin);
      })
    : allKeys;

  if (keysToFetch.length === 0) {
    return { storage: [], origins: allOrigins };
  }

  // Fetch localStorage for matching keys
  const pipeline = redis.pipeline();
  for (const key of keysToFetch) {
    pipeline.get(key);
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
          storage.push({ origin: extractOriginFromKey(keysToFetch[i]), data });
        }
      } catch {
        // Skip invalid data
      }
    }
  }

  return { storage, origins: allOrigins };
}
