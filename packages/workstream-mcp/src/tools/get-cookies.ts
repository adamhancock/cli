import { getRedisClient } from '../redis-client.js';
import { REDIS_KEYS, type ChromeCookie } from '../types.js';

export interface GetCookiesInput {
  domain?: string;
  name?: string;
}

export interface GetCookiesOutput {
  cookies: Array<ChromeCookie & { sourceDomain: string }>;
  domains: string[];
}

export async function getCookies(input: GetCookiesInput): Promise<GetCookiesOutput> {
  const redis = getRedisClient();

  // Get all domains with cookies
  const allDomains = await redis.hkeys(REDIS_KEYS.CHROME_COOKIES);

  // Filter domains if a specific domain is requested
  const domainsToFetch = input.domain
    ? allDomains.filter((d) => d.includes(input.domain!) || input.domain!.includes(d))
    : allDomains;

  if (domainsToFetch.length === 0) {
    return { cookies: [], domains: allDomains };
  }

  // Fetch cookies for matching domains
  const pipeline = redis.pipeline();
  for (const domain of domainsToFetch) {
    pipeline.hget(REDIS_KEYS.CHROME_COOKIES, domain);
  }

  const results = await pipeline.exec();
  const cookies: Array<ChromeCookie & { sourceDomain: string }> = [];

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i];
      if (err || !data) continue;

      try {
        const domainCookies: ChromeCookie[] = JSON.parse(data as string);
        for (const cookie of domainCookies) {
          // Filter by name if specified
          if (input.name && cookie.name !== input.name) {
            continue;
          }
          cookies.push({ ...cookie, sourceDomain: domainsToFetch[i] });
        }
      } catch {
        // Skip invalid data
      }
    }
  }

  return { cookies, domains: allDomains };
}
