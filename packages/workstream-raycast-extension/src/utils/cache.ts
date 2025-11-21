import { Cache, LocalStorage } from '@raycast/api';
import type { InstanceWithStatus } from '../types';

const cache = new Cache();
const CACHE_KEY = 'vscode-instances';
const CACHE_DURATION = 60 * 1000; // 60 seconds - longer cache for better performance

export interface CachedData {
  instances: InstanceWithStatus[];
  timestamp: number;
}

/**
 * Get cached instances if they're still fresh
 */
export function getCachedInstances(): InstanceWithStatus[] | null {
  try {
    const cached = cache.get(CACHE_KEY);
    if (!cached) return null;

    const data: CachedData = JSON.parse(cached);
    const age = Date.now() - data.timestamp;

    if (age > CACHE_DURATION) {
      // Cache expired
      return null;
    }

    return data.instances;
  } catch {
    return null;
  }
}

/**
 * Cache instances with current timestamp
 */
export function setCachedInstances(instances: InstanceWithStatus[]): void {
  try {
    const data: CachedData = {
      instances,
      timestamp: Date.now(),
    };
    cache.set(CACHE_KEY, JSON.stringify(data));
  } catch (error) {
    console.error('Failed to cache instances:', error);
  }
}

/**
 * Clear the cache
 */
export function clearCache(): void {
  cache.remove(CACHE_KEY);
}

const USAGE_HISTORY_KEY = 'usage-history';

export interface UsageHistory {
  [path: string]: number; // path -> timestamp of last access
}

/**
 * Record that a workspace was accessed via Raycast
 */
export function recordUsage(path: string): void {
  try {
    const cached = cache.get(USAGE_HISTORY_KEY);
    const history: UsageHistory = cached ? JSON.parse(cached) : {};
    history[path] = Date.now();
    cache.set(USAGE_HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Failed to record usage:', error);
  }
}

/**
 * Get usage history for sorting
 */
export function getUsageHistory(): UsageHistory {
  try {
    const cached = cache.get(USAGE_HISTORY_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch {
    return {};
  }
}

// Chrome Profile Storage
const CHROME_PROFILE_KEY = 'selected-chrome-profile';

/**
 * Set the selected Chrome profile (persists across sessions)
 */
export async function setSelectedChromeProfile(profilePath: string): Promise<void> {
  await LocalStorage.setItem(CHROME_PROFILE_KEY, profilePath);
}

/**
 * Get the selected Chrome profile
 */
export async function getSelectedChromeProfile(): Promise<string | undefined> {
  return await LocalStorage.getItem<string>(CHROME_PROFILE_KEY);
}

/**
 * Clear the selected Chrome profile
 */
export async function clearSelectedChromeProfile(): Promise<void> {
  await LocalStorage.removeItem(CHROME_PROFILE_KEY);
}
