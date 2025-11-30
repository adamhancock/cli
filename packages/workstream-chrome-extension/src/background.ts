import { io, Socket } from 'socket.io-client';
import type {
  ChromeCookie,
  ChromeCookieUpdate,
  ChromeRequestLog,
  ChromeLocalStorageUpdate,
  ExtensionConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';

let socket: Socket | null = null;
let config: ExtensionConfig = DEFAULT_CONFIG;
let requestBuffer: ChromeRequestLog[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;

// Load config from storage
async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.sync.get('config');
  if (stored.config) {
    config = { ...DEFAULT_CONFIG, ...stored.config };
  }
  return config;
}

// Save config to storage
async function saveConfig(newConfig: Partial<ExtensionConfig>): Promise<void> {
  config = { ...config, ...newConfig };
  await chrome.storage.sync.set({ config });
}

// Check if a domain matches any of the tracked patterns
function matchesDomain(domain: string): boolean {
  return config.trackedDomains.some((pattern) => {
    if (pattern.startsWith('*.')) {
      // Wildcard pattern - match any subdomain
      const baseDomain = pattern.slice(2);
      return domain === baseDomain || domain.endsWith('.' + baseDomain);
    }
    return domain === pattern;
  });
}

// Extract domain from URL
function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}

// Connect to daemon WebSocket
function connectToDaemon(): void {
  if (socket?.connected) {
    return;
  }

  console.log('[Workstream] Connecting to daemon at', config.daemonWsUrl);

  socket = io(config.daemonWsUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    auth: config.authToken ? { token: config.authToken } : undefined,
  });

  socket.on('connect', () => {
    console.log('[Workstream] Connected to daemon');
    // Sync all cookies for tracked domains on connect
    syncAllCookies();
  });

  socket.on('disconnect', () => {
    console.log('[Workstream] Disconnected from daemon');
  });

  socket.on('connect_error', (error) => {
    console.error('[Workstream] Connection error:', error.message);
  });
}

// Disconnect from daemon
function disconnectFromDaemon(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Convert Chrome cookie to our format
function convertCookie(cookie: chrome.cookies.Cookie): ChromeCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite as ChromeCookie['sameSite'],
    expirationDate: cookie.expirationDate,
  };
}

// Sync all cookies for a domain
async function syncCookiesForDomain(domain: string): Promise<void> {
  if (!socket?.connected) return;

  const cookies = await chrome.cookies.getAll({ domain });
  const convertedCookies = cookies.map(convertCookie);

  const update: ChromeCookieUpdate = {
    domain,
    cookies: convertedCookies,
    timestamp: Date.now(),
  };

  socket.emit('chrome:cookies', update);
  console.log(`[Workstream] Synced ${cookies.length} cookies for ${domain}`);
}

// Sync all cookies for all tracked domains
async function syncAllCookies(): Promise<void> {
  // Get unique base domains from patterns
  const domains = new Set<string>();
  for (const pattern of config.trackedDomains) {
    if (pattern.startsWith('*.')) {
      domains.add(pattern.slice(2));
    } else {
      domains.add(pattern);
    }
  }

  for (const domain of domains) {
    await syncCookiesForDomain(domain);
  }
}

// Flush buffered requests to daemon
function flushRequests(): void {
  if (!socket?.connected || requestBuffer.length === 0) {
    return;
  }

  socket.emit('chrome:requests', requestBuffer);
  console.log(`[Workstream] Sent ${requestBuffer.length} request logs`);
  requestBuffer = [];
  flushTimeout = null;
}

// Buffer a request and schedule flush
function bufferRequest(request: ChromeRequestLog): void {
  requestBuffer.push(request);

  // Flush after 1 second or when buffer reaches 50 items
  if (requestBuffer.length >= 50) {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    flushRequests();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushRequests, 1000);
  }
}

// Send localStorage update
function sendLocalStorageUpdate(origin: string, data: Record<string, string>): void {
  if (!socket?.connected) return;

  const update: ChromeLocalStorageUpdate = {
    origin,
    data,
    timestamp: Date.now(),
  };

  socket.emit('chrome:localstorage', update);
  console.log(`[Workstream] Sent localStorage for ${origin} (${Object.keys(data).length} keys)`);
}

// Cookie change listener
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!config.enabled) return;

  const domain = changeInfo.cookie.domain.replace(/^\./, '');
  if (!matchesDomain(domain)) return;

  // Sync all cookies for this domain (simpler than tracking individual changes)
  syncCookiesForDomain(domain);
});

// Web request listener
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!config.enabled) return;

    const domain = getDomainFromUrl(details.url);
    if (!matchesDomain(domain)) return;

    const request: ChromeRequestLog = {
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: details.responseHeaders?.reduce(
        (acc, h) => {
          acc[h.name] = h.value || '';
          return acc;
        },
        {} as Record<string, string>
      ),
      timestamp: details.timeStamp,
      tabId: details.tabId,
      frameId: details.frameId,
      type: details.type,
    };

    bufferRequest(request);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'LOCALSTORAGE_UPDATE') {
    // From content script
    if (config.enabled) {
      const origin = message.origin;
      const domain = new URL(origin).hostname;
      if (matchesDomain(domain)) {
        sendLocalStorageUpdate(origin, message.data);
      }
    }
    sendResponse({ success: true });
  } else if (message.type === 'GET_CONFIG') {
    sendResponse(config);
  } else if (message.type === 'SET_CONFIG') {
    const urlChanged = message.config.daemonWsUrl && message.config.daemonWsUrl !== config.daemonWsUrl;
    const tokenChanged = message.config.authToken !== undefined && message.config.authToken !== config.authToken;

    saveConfig(message.config).then(() => {
      // Reconnect if URL or token changed, or if enabling
      if (urlChanged || tokenChanged) {
        disconnectFromDaemon();
        if (config.enabled) {
          connectToDaemon();
        }
      } else if (message.config.enabled !== undefined) {
        if (message.config.enabled) {
          connectToDaemon();
        } else {
          disconnectFromDaemon();
        }
      }
      sendResponse({ success: true });
    });
    return true; // Async response
  } else if (message.type === 'GET_STATUS') {
    sendResponse({
      connected: socket?.connected ?? false,
      enabled: config.enabled,
      bufferedRequests: requestBuffer.length,
    });
  } else if (message.type === 'SYNC_NOW') {
    syncAllCookies().then(() => {
      flushRequests();
      sendResponse({ success: true });
    });
    return true;
  }
});

// Initialize on startup
loadConfig().then(() => {
  if (config.enabled) {
    connectToDaemon();
  }
});

console.log('[Workstream] Background service worker initialized');
