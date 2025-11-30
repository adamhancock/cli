import { getRedisClient } from '../redis-client.js';
import { REDIS_KEYS, type ChromeRequestLog } from '../types.js';

export interface GetRequestsInput {
  domain?: string;
  method?: string;
  limit?: number;
  statusCode?: number;
  path?: string;
  type?: string;
}

export interface GetRequestsOutput {
  requests: ChromeRequestLog[];
  total: number;
}

export async function getRecentRequests(input: GetRequestsInput): Promise<GetRequestsOutput> {
  const redis = getRedisClient();
  const limit = Math.min(input.limit || 100, 1000);

  // Get total count
  const total = await redis.llen(REDIS_KEYS.CHROME_REQUESTS);

  // Fetch more than limit to account for filtering
  const hasFilters = input.domain || input.method || input.statusCode || input.path || input.type;
  const fetchCount = hasFilters ? limit * 3 : limit;
  const rawRequests = await redis.lrange(REDIS_KEYS.CHROME_REQUESTS, 0, fetchCount - 1);

  let requests: ChromeRequestLog[] = [];

  for (const raw of rawRequests) {
    try {
      const request: ChromeRequestLog = JSON.parse(raw);

      // Apply filters
      if (input.domain) {
        const url = new URL(request.url);
        if (!url.hostname.includes(input.domain)) continue;
      }

      if (input.method && request.method.toUpperCase() !== input.method.toUpperCase()) {
        continue;
      }

      if (input.statusCode && request.statusCode !== input.statusCode) {
        continue;
      }

      if (input.path) {
        const url = new URL(request.url);
        if (!url.pathname.includes(input.path)) continue;
      }

      if (input.type && request.type.toLowerCase() !== input.type.toLowerCase()) {
        continue;
      }

      requests.push(request);

      if (requests.length >= limit) break;
    } catch {
      // Skip invalid entries
    }
  }

  return { requests, total };
}
