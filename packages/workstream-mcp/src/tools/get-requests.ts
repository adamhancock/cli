import { getRedisClient } from '../redis-client.js';
import { REDIS_KEY_PATTERNS, type ChromeRequestLog } from '../types.js';

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
  domains: string[];
  total: number;
}

// Extract domain from key like "workstream:chrome:requests:example.com"
function extractDomainFromKey(key: string): string {
  const prefix = 'workstream:chrome:requests:';
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export async function getRecentRequests(input: GetRequestsInput): Promise<GetRequestsOutput> {
  const redis = getRedisClient();
  const limit = Math.min(input.limit || 100, 1000);

  // Scan for all request keys
  const allKeys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', REDIS_KEY_PATTERNS.CHROME_REQUESTS, 'COUNT', 100);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== '0');

  const allDomains = allKeys.map(extractDomainFromKey);

  // Filter keys if a specific domain is requested
  const keysToFetch = input.domain
    ? allKeys.filter((key) => {
        const domain = extractDomainFromKey(key);
        return domain.includes(input.domain!) || input.domain!.includes(domain);
      })
    : allKeys;

  if (keysToFetch.length === 0) {
    return { requests: [], domains: allDomains, total: 0 };
  }

  // Fetch requests for matching keys
  const pipeline = redis.pipeline();
  for (const key of keysToFetch) {
    pipeline.get(key);
  }

  const results = await pipeline.exec();
  let allRequests: ChromeRequestLog[] = [];

  if (results) {
    for (const [err, rawData] of results) {
      if (err || !rawData) continue;

      try {
        const domainRequests: ChromeRequestLog[] = JSON.parse(rawData as string);
        allRequests.push(...domainRequests);
      } catch {
        // Skip invalid data
      }
    }
  }

  // Sort by timestamp (most recent first)
  allRequests.sort((a, b) => b.timestamp - a.timestamp);

  const total = allRequests.length;

  // Apply filters
  let filteredRequests: ChromeRequestLog[] = [];
  for (const request of allRequests) {
    if (input.method && request.method.toUpperCase() !== input.method.toUpperCase()) {
      continue;
    }

    if (input.statusCode && request.statusCode !== input.statusCode) {
      continue;
    }

    if (input.path) {
      try {
        const url = new URL(request.url);
        if (!url.pathname.includes(input.path)) continue;
      } catch {
        continue;
      }
    }

    if (input.type && request.type.toLowerCase() !== input.type.toLowerCase()) {
      continue;
    }

    filteredRequests.push(request);

    if (filteredRequests.length >= limit) break;
  }

  return { requests: filteredRequests, domains: allDomains, total };
}
