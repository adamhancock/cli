import { getRedisClient } from '../redis-client.js';
import { REDIS_KEYS, type ChromeCookie } from '../types.js';

export interface GenerateCurlInput {
  url: string;
  method?: string;
  includeAuth?: boolean;
  headers?: Record<string, string>;
  data?: string;
}

export interface GenerateCurlOutput {
  curl: string;
  cookiesUsed: string[];
}

export async function generateCurl(input: GenerateCurlInput): Promise<GenerateCurlOutput> {
  const redis = getRedisClient();
  const method = input.method?.toUpperCase() || 'GET';

  // Parse URL to get domain
  let domain: string;
  try {
    const url = new URL(input.url);
    domain = url.hostname;
  } catch {
    throw new Error(`Invalid URL: ${input.url}`);
  }

  const parts: string[] = ['curl'];

  // Add method if not GET
  if (method !== 'GET') {
    parts.push(`-X ${method}`);
  }

  // Add cookies if requested
  const cookiesUsed: string[] = [];
  if (input.includeAuth !== false) {
    // Find matching domain in stored cookies
    const allDomains = await redis.hkeys(REDIS_KEYS.CHROME_COOKIES);
    const matchingDomain = allDomains.find(
      (d) => domain === d || domain.endsWith('.' + d) || d.endsWith('.' + domain)
    );

    if (matchingDomain) {
      const cookieData = await redis.hget(REDIS_KEYS.CHROME_COOKIES, matchingDomain);
      if (cookieData) {
        try {
          const cookies: ChromeCookie[] = JSON.parse(cookieData);
          const cookieStrings: string[] = [];

          for (const cookie of cookies) {
            // Check if cookie applies to this domain/path
            const cookieDomain = cookie.domain.replace(/^\./, '');
            if (domain === cookieDomain || domain.endsWith('.' + cookieDomain)) {
              cookieStrings.push(`${cookie.name}=${cookie.value}`);
              cookiesUsed.push(cookie.name);
            }
          }

          if (cookieStrings.length > 0) {
            parts.push(`-H 'Cookie: ${cookieStrings.join('; ')}'`);
          }
        } catch {
          // Skip if cookie data is invalid
        }
      }
    }
  }

  // Add custom headers
  if (input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      parts.push(`-H '${key}: ${value}'`);
    }
  }

  // Add data if provided
  if (input.data) {
    parts.push(`-d '${input.data.replace(/'/g, "'\\''")}'`);
  }

  // Add URL (quoted)
  parts.push(`'${input.url}'`);

  return {
    curl: parts.join(' \\\n  '),
    cookiesUsed,
  };
}
