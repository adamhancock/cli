import type { ChromeConsoleMessage } from './types';

// Content script - runs in the context of web pages
// Can access localStorage and send data to background script

function getLocalStorageData(): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        data[key] = value;
      }
    }
  }
  return data;
}

let messagingDisabled = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;

function handleStorageEvent(): void {
  if (!messagingDisabled) {
    syncLocalStorage();
  }
}

function disableMessaging(): void {
  if (messagingDisabled) {
    return;
  }
  messagingDisabled = true;
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  window.removeEventListener('storage', handleStorageEvent);
}

function sendMessageSafely(message: unknown): void {
  if (messagingDisabled) {
    return;
  }

  try {
    chrome.runtime.sendMessage(message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (messageText.includes('Extension context invalidated')) {
      disableMessaging();
      return;
    }
    // For other errors, log once to aid debugging and disable to avoid spamming
    console.warn('[Workstream] Failed to relay message from content script:', messageText);
    disableMessaging();
  }
}

function syncLocalStorage(): void {
  if (messagingDisabled) {
    return;
  }

  const data = getLocalStorageData();
  const origin = window.location.origin;

  sendMessageSafely({
    type: 'LOCALSTORAGE_UPDATE',
    origin,
    data,
    timestamp: Date.now(),
  });
}

// Sync on page load
syncLocalStorage();

// Listen for storage events (changes from other tabs/windows)
window.addEventListener('storage', handleStorageEvent);

// Also sync periodically to catch programmatic changes
syncInterval = setInterval(() => {
  if (!messagingDisabled) {
    syncLocalStorage();
  }
}, 5000);

// Listen for requests from background to sync
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SYNC_LOCALSTORAGE') {
    if (messagingDisabled) {
      sendResponse({ success: false, disabled: true });
      return;
    }
    syncLocalStorage();
    sendResponse({ success: true });
  }
});

const CONSOLE_LEVELS: ChromeConsoleMessage['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
const MAX_CONSOLE_ARGS = 10;
const MAX_CONSOLE_ARG_LENGTH = 500;
const MAX_STACK_LENGTH = 2000;

function truncateConsoleValue(value: string): string {
  if (value.length <= MAX_CONSOLE_ARG_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_CONSOLE_ARG_LENGTH) + '…';
}

function serializeConsoleArg(value: unknown): string {
  if (typeof value === 'string') {
    return truncateConsoleValue(value);
  }
  if (value instanceof Error) {
    return truncateConsoleValue(value.stack || `${value.name}: ${value.message}`);
  }
  try {
    return truncateConsoleValue(JSON.stringify(value));
  } catch {
    return truncateConsoleValue(String(value));
  }
}

function captureStackTrace(): string | undefined {
  const error = new Error();
  if (!error.stack) {
    return undefined;
  }
  return error.stack
    .split('\n')
    .slice(3)
    .join('\n')
    .trim()
    .slice(0, MAX_STACK_LENGTH);
}

function sendConsoleMessage(level: ChromeConsoleMessage['level'], args: unknown[]): void {
  if (messagingDisabled) {
    return;
  }

  const payload: ChromeConsoleMessage = {
    level,
    args: args.slice(0, MAX_CONSOLE_ARGS).map(serializeConsoleArg),
    timestamp: Date.now(),
    origin: window.location.origin,
    url: window.location.href,
    stack: captureStackTrace(),
  };

  sendMessageSafely({ type: 'CONSOLE_MESSAGE', payload });
}

function setupConsoleCapture(): void {
  const globalWindow = window as typeof window & { __workstreamConsolePatched?: boolean };
  if (globalWindow.__workstreamConsolePatched) {
    return;
  }
  globalWindow.__workstreamConsolePatched = true;

  const consoleWithLevels = console as Console & Record<ChromeConsoleMessage['level'], (...args: unknown[]) => void>;

  for (const level of CONSOLE_LEVELS) {
    const original = consoleWithLevels[level].bind(consoleWithLevels);
    consoleWithLevels[level] = (...args: unknown[]) => {
      sendConsoleMessage(level, args);
      original(...args);
    };
  }
}

setupConsoleCapture();

