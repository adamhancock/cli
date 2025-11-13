import { exec } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';

const execAsync = promisify(exec);

export interface ChromeTab {
  index: number;
  title: string;
  url: string;
  favicon?: string;
}

export interface ChromeWindow {
  id: number;
  tabs: ChromeTab[];
  lastUpdated: number;
}

/**
 * Normalize a URL including path for more specific tab matching.
 * This allows matching tabs with the same hostname, port, and path.
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Match by hostname, port, and path (ignore query/hash)
    const hostname = urlObj.hostname.replace(/^www\./, '');
    const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
    const pathname = urlObj.pathname;
    return `${hostname}:${port}${pathname}`;
  } catch {
    return url;
  }
}

/**
 * Load Chrome windows and tabs from Redis cache.
 */
export async function getChromeWindows(): Promise<ChromeWindow[]> {
  try {
    const redis = new Redis({
      host: 'localhost',
      port: 6379,
    });

    const data = await redis.get('workstream:chrome:windows');
    await redis.quit();

    if (data) {
      return JSON.parse(data) as ChromeWindow[];
    }
  } catch (error) {
    console.error('Failed to load Chrome windows:', error);
  }
  return [];
}

/**
 * Find a Chrome tab matching the target URL (by hostname:port:path).
 */
export async function findChromeTab(targetUrl: string): Promise<{ windowId: number; tabIndex: number } | null> {
  const windows = await getChromeWindows();
  const normalizedTarget = normalizeUrl(targetUrl);

  for (const window of windows) {
    for (const tab of window.tabs) {
      if (normalizeUrl(tab.url) === normalizedTarget) {
        return { windowId: window.id, tabIndex: tab.index };
      }
    }
  }

  return null;
}

/**
 * Switch to an existing Chrome tab.
 */
export async function switchToChromeTab(windowId: number, tabIndex: number) {
  const script = `
    tell application "Google Chrome"
      activate
      set _wnd to first window where id is ${windowId}
      set index of _wnd to 1
      set active tab index of _wnd to ${tabIndex + 1}
    end tell
  `;
  await execAsync(`osascript -e '${script}'`);
}

/**
 * Open a new Chrome tab with the given URL.
 */
export async function openNewChromeTab(url: string) {
  // Escape single quotes in URL
  const escapedUrl = url.replace(/'/g, "'\"'\"'");
  const script = `
    tell application "Google Chrome"
      activate
      open location "${escapedUrl}"
    end tell
  `;
  await execAsync(`osascript -e '${script}'`);
}
