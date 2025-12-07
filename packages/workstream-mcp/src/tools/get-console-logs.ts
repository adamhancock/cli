import { getRedisClient } from '../redis-client.js';
import { REDIS_KEY_PATTERNS, type ChromeConsoleMessage } from '../types.js';

export interface GetConsoleLogsInput {
  origin?: string;
  level?: ChromeConsoleMessage['level'];
  search?: string;
  limit?: number;
}

export interface GetConsoleLogsOutput {
  logs: ChromeConsoleMessage[];
  origins: string[];
  total: number;
}

function extractOriginFromKey(key: string): string {
  const prefix = 'workstream:chrome:console:';
  const encoded = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export async function getConsoleLogs(input: GetConsoleLogsInput): Promise<GetConsoleLogsOutput> {
  const redis = getRedisClient();
  const limit = Math.min(input.limit || 100, 500);
  const searchTerm = input.search?.toLowerCase();

  const allKeys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      REDIS_KEY_PATTERNS.CHROME_CONSOLE,
      'COUNT',
      100
    );
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== '0');

  const allOrigins = allKeys.map(extractOriginFromKey);

  const keysToFetch = input.origin
    ? allKeys.filter((key) => {
        const origin = extractOriginFromKey(key);
        return origin.includes(input.origin!) || input.origin!.includes(origin);
      })
    : allKeys;

  if (keysToFetch.length === 0) {
    return { logs: [], origins: allOrigins, total: 0 };
  }

  const pipeline = redis.pipeline();
  for (const key of keysToFetch) {
    pipeline.get(key);
  }

  const results = await pipeline.exec();
  let logs: ChromeConsoleMessage[] = [];

  if (results) {
    for (const [err, rawData] of results) {
      if (err || !rawData) continue;
      try {
        const parsed: ChromeConsoleMessage[] = JSON.parse(rawData as string);
        logs.push(...parsed);
      } catch {
        // Ignore invalid payloads
      }
    }
  }

  logs.sort((a, b) => b.timestamp - a.timestamp);
  const total = logs.length;

  const filteredLogs: ChromeConsoleMessage[] = [];
  for (const log of logs) {
    if (input.level && log.level !== input.level) {
      continue;
    }

    if (searchTerm) {
      const stackMatches = log.stack?.toLowerCase().includes(searchTerm);
      const urlMatches = log.url?.toLowerCase().includes(searchTerm);
      const argsMatch = log.args?.some((arg) => arg.toLowerCase().includes(searchTerm));
      if (!stackMatches && !urlMatches && !argsMatch) {
        continue;
      }
    }

    filteredLogs.push(log);
    if (filteredLogs.length >= limit) {
      break;
    }
  }

  return {
    logs: filteredLogs,
    origins: allOrigins,
    total,
  };
}
