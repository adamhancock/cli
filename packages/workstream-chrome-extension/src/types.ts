// Chrome extension types - matching workstream-daemon/src/websocket-types.ts

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

export interface ChromeCookieUpdate {
  domain: string;
  cookies: ChromeCookie[];
  timestamp: number;
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

export interface ChromeLocalStorageUpdate {
  origin: string;
  data: Record<string, string>;
  timestamp: number;
}

export interface ExtensionConfig {
  enabled: boolean;
  trackedDomains: string[];
  daemonWsUrl: string;
  authToken: string;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  trackedDomains: ['*.localhost'],
  daemonWsUrl: 'ws://localhost:58234',
  authToken: '',
};
