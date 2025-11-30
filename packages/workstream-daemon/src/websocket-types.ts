/**
 * WebSocket message types for workstream-daemon
 * Port: 9995
 */

// Chrome extension types
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
  type: string;  // 'main_frame', 'sub_frame', 'xmlhttprequest', etc.
}

export interface ChromeLocalStorageUpdate {
  origin: string;
  data: Record<string, string>;
  timestamp: number;
}

// Client → Server messages
export interface ClientToServerEvents {
  subscribe: () => void;
  'get-instances': () => void;
  ping: () => void;
  // Chrome extension events
  'chrome:cookies': (data: ChromeCookieUpdate) => void;
  'chrome:requests': (data: ChromeRequestLog[]) => void;
  'chrome:localstorage': (data: ChromeLocalStorageUpdate) => void;
}

// Server → Client messages
export interface ServerToClientEvents {
  instances: (instances: any[]) => void;
  'instance-updated': (instance: any) => void;
  'claude-event': (data: ClaudeEventData) => void;
  notification: (data: NotificationData) => void;
  pong: () => void;
}

export interface ClaudeEventData {
  path: string;
  type: 'work_started' | 'waiting_for_input' | 'work_stopped' | 'compacting_started';
  pid?: number;
  terminalName?: string;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  timestamp: number;
}

export interface NotificationData {
  type: string;
  title: string;
  message: string;
  path?: string;
  timestamp: number;
}
