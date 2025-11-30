import { getRedisClient } from '../redis-client.js';
import { REDIS_KEY_PATTERNS, type ChromeRequestLog } from '../types.js';

export interface GetRequestsInput {
  domain?: string;
  port?: number | string;
  method?: string;
  limit?: number;
  statusCode?: number;
  path?: string;
  type?: string;
}

export interface GetRequestsOutput {
  requests: ChromeRequestLog[];
  destinations: string[];  // domain:port pairs
  total: number;
}

// Extract domain and port from key like "workstream:chrome:requests:example.com:3000"
function extractDestinationFromKey(key: string): { domain: string; port: string } {
  const prefix = 'workstream:chrome:requests:';
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  // Split on last colon to handle IPv6 or domains with colons
  const lastColonIndex = rest.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return { domain: rest, port: '80' };
  }
  return {
    domain: rest.slice(0, lastColonIndex),
    port: rest.slice(lastColonIndex + 1),
  };
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

  const allDestinations = allKeys.map((key) => {
    const { domain, port } = extractDestinationFromKey(key);
    return `${domain}:${port}`;
  });

  // Filter keys by domain and/or port if specified
  const keysToFetch = allKeys.filter((key) => {
    const { domain, port } = extractDestinationFromKey(key);

    if (input.domain) {
      if (!domain.includes(input.domain) && !input.domain.includes(domain)) {
        return false;
      }
    }

    if (input.port) {
      if (port !== String(input.port)) {
        return false;
      }
    }

    return true;
  });

  if (keysToFetch.length === 0) {
    return { requests: [], destinations: allDestinations, total: 0 };
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
        const destRequests: ChromeRequestLog[] = JSON.parse(rawData as string);
        allRequests.push(...destRequests);
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

  return { requests: filteredRequests, destinations: allDestinations, total };
}
