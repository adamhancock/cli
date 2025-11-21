import { exec } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getSelectedChromeProfile } from './cache';

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

export interface ChromeProfile {
  name: string;
  path: string;
  isDefault: boolean;
  avatar?: string;
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
export async function switchToChromeTab(windowId: number, tabIndex: number, profile?: string) {
  // Note: When switching to an existing tab, we don't need to specify profile
  // since the tab is already in a specific profile's window
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
 * @param url - The URL to open
 * @param profile - Optional Chrome profile directory name (e.g., "Default", "Profile 1")
 */
export async function openNewChromeTab(url: string, profile?: string) {
  if (profile) {
    // Use Chrome CLI with profile directory for reliable profile targeting
    // Escape shell arguments properly
    const escapedUrl = url.replace(/"/g, '\\"');
    const escapedProfile = profile.replace(/"/g, '\\"');
    await execAsync(`open -na "Google Chrome" --args --profile-directory="${escapedProfile}" "${escapedUrl}"`);
  } else {
    // Fallback to AppleScript if no profile specified
    const escapedUrl = url.replace(/'/g, "'\"'\"'");
    const script = `
      tell application "Google Chrome"
        activate
        open location "${escapedUrl}"
      end tell
    `;
    await execAsync(`osascript -e '${script}'`);
  }
}

/**
 * Get all Chrome profiles on the system.
 * Reads from ~/Library/Application Support/Google/Chrome/
 */
export async function getChromeProfiles(): Promise<ChromeProfile[]> {
  const chromeDir = join(homedir(), 'Library/Application Support/Google/Chrome');
  const profiles: ChromeProfile[] = [];

  try {
    // Check if Chrome directory exists
    await access(chromeDir);

    // Read all entries in Chrome directory
    const entries = await readdir(chromeDir, { withFileTypes: true });

    // Filter for profile directories (Default, Profile 1, Profile 2, etc.)
    const profileDirs = entries.filter(
      (entry) => entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile '))
    );

    // Read preferences for each profile
    for (const dir of profileDirs) {
      try {
        const prefsPath = join(chromeDir, dir.name, 'Preferences');
        const prefsData = await readFile(prefsPath, 'utf-8');
        const prefs = JSON.parse(prefsData);

        // Extract profile information
        const profileName = prefs?.profile?.name || dir.name;
        const avatarUrl = prefs?.profile?.gaia_info_picture_url;

        profiles.push({
          name: profileName,
          path: dir.name,
          isDefault: dir.name === 'Default',
          avatar: avatarUrl,
        });
      } catch (error) {
        // If we can't read preferences, skip this profile
        console.error(`Failed to read preferences for ${dir.name}:`, error);
      }
    }

    // Sort profiles: Default first, then by name
    profiles.sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });

    return profiles;
  } catch (error) {
    console.error('Failed to load Chrome profiles:', error);
    return [];
  }
}

/**
 * Detect the best Chrome profile based on open tabs with work-related content.
 * Returns null if unable to determine.
 */
export async function detectBestChromeProfile(): Promise<string | null> {
  try {
    const windows = await getChromeWindows();
    if (windows.length === 0) return null;

    // Work-related domains to look for
    const workDomains = ['localhost', 'github.com', 'gitlab.com', '.local'];

    // Count work-related tabs per profile (assuming profile info in window data)
    // Note: Current Chrome window data doesn't include profile info,
    // so this is a placeholder for future enhancement
    // For now, we can't reliably detect profile from tab data alone

    // TODO: Enhance daemon to include profile info in Chrome window data
    console.log('[Profile Detection] Chrome window data does not include profile information yet');
    return null;
  } catch (error) {
    console.error('[Profile Detection] Failed:', error);
    return null;
  }
}

/**
 * Resolve which Chrome profile to use for opening tabs.
 * Priority: 1) Stored preference, 2) Smart detection, 3) Default profile
 */
export async function resolveTargetChromeProfile(): Promise<string | undefined> {
  try {
    // 1. Try stored profile selection
    const stored = await getSelectedChromeProfile();
    if (stored) {
      console.log('[Profile Resolution] Using stored profile:', stored);
      return stored;
    }

    // 2. Try smart detection
    const detected = await detectBestChromeProfile();
    if (detected) {
      console.log('[Profile Resolution] Using detected profile:', detected);
      return detected;
    }

    // 3. Return undefined to use default behavior
    console.log('[Profile Resolution] No profile preference, using default behavior');
    return undefined;
  } catch (error) {
    console.error('[Profile Resolution] Error:', error);
    return undefined;
  }
}
