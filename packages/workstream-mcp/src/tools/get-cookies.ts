import { getRedisClient } from '../redis-client.js';
import { REDIS_KEY_PATTERNS, REDIS_KEYS, type ChromeCookie } from '../types.js';

export interface GetCookiesInput {
  domain?: string;
  name?: string;
}

export interface GetCookiesOutput {
  cookies: Array<ChromeCookie & { sourceDomain: string }>;
  domains: string[];
}

// Extract domain from key like "workstream:chrome:cookies:example.com"
function extractDomainFromKey(key: string): string {
  const prefix = 'workstream:chrome:cookies:';
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export async function getCookies(input: GetCookiesInput): Promise<GetCookiesOutput> {
  const redis = getRedisClient();

  // Scan for all cookie keys
  const allKeys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', REDIS_KEY_PATTERNS.CHROME_COOKIES, 'COUNT', 100);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== '0');

  const allDomains = allKeys.map(extractDomainFromKey);

  // Filter domains if a specific domain is requested
  const keysToFetch = input.domain
    ? allKeys.filter((key) => {
        const domain = extractDomainFromKey(key);
        return domain.includes(input.domain!) || input.domain!.includes(domain);
      })
    : allKeys;

  if (keysToFetch.length === 0) {
    return { cookies: [], domains: allDomains };
  }

  // Fetch cookies for matching keys
  const pipeline = redis.pipeline();
  for (const key of keysToFetch) {
    pipeline.get(key);
  }

  const results = await pipeline.exec();
  const cookies: Array<ChromeCookie & { sourceDomain: string }> = [];

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i];
      if (err || !data) continue;

      try {
        const domainCookies: ChromeCookie[] = JSON.parse(data as string);
        const sourceDomain = extractDomainFromKey(keysToFetch[i]);
        for (const cookie of domainCookies) {
          // Filter by name if specified
          if (input.name && cookie.name !== input.name) {
            continue;
          }
          cookies.push({ ...cookie, sourceDomain });
        }
      } catch {
        // Skip invalid data
      }
    }
  }

  return { cookies, domains: allDomains };
}
