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
 * Normalize a URL for tab matching.
 * - For localhost/dev with explicit port: Match by hostname:port (e.g., Spotlight on :9018)
 * - For localhost/dev with default port: Match by hostname only (HTTP vs HTTPS handling)
 * - For external sites: Include full path for specific matching
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');

    // For localhost/dev environments
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      // If there's an explicit port (not default), include it to distinguish
      // different services (e.g., main app on :443 vs Spotlight on :9018)
      if (urlObj.port) {
        return `${hostname}:${urlObj.port}`;
      }
      // For default ports (80/443), just match by hostname to handle HTTP vs HTTPS
      return hostname;
    }

    // For external sites, include full path for more specific matching
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
 * Find a Chrome tab matching the target URL.
 * - For localhost/dev: matches by hostname:port
 * - For external sites: matches by hostname:port:path
 */
export async function findChromeTab(targetUrl: string): Promise<{ windowId: number; tabIndex: number } | null> {
  const windows = await getChromeWindows();
  const normalizedTarget = normalizeUrl(targetUrl);

  console.log('[Tab Detection] Looking for:', targetUrl);
  console.log('[Tab Detection] Normalized target:', normalizedTarget);

  for (const window of windows) {
    for (const tab of window.tabs) {
      const normalizedTab = normalizeUrl(tab.url);
      if (normalizedTab === normalizedTarget) {
        console.log('[Tab Detection] ✓ FOUND matching tab:', tab.url);
        return { windowId: window.id, tabIndex: tab.index };
      }
    }
  }

  console.log('[Tab Detection] ✗ No matching tab found');
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
