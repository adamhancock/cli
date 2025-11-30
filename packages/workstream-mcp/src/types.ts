// Types matching workstream-daemon

export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
}

export interface ChromeRequestLog {
  url: string;
  method: string;
  statusCode: number;
  statusLine: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timestamp: number;
  tabId?: number;
  frameId?: number;
  type: string;
}

export interface ChromeLocalStorageData {
  origin: string;
  data: Record<string, string>;
}

// Redis keys - must match workstream-daemon/src/redis-client.ts
// Keys are per-domain/origin with 24h TTL
export const REDIS_KEY_PATTERNS = {
  CHROME_COOKIES: 'workstream:chrome:cookies:*',
  CHROME_REQUESTS: 'workstream:chrome:requests:*',
  CHROME_LOCALSTORAGE: 'workstream:chrome:localstorage:*',
} as const;

export const REDIS_KEYS = {
  CHROME_COOKIES: (domain: string) => `workstream:chrome:cookies:${domain}`,
  CHROME_REQUESTS: (domain: string, port: string | number) => `workstream:chrome:requests:${domain}:${port}`,
  CHROME_LOCALSTORAGE: (origin: string) => `workstream:chrome:localstorage:${encodeURIComponent(origin)}`,
} as const;
