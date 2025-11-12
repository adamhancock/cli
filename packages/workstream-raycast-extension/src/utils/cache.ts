import { Cache } from '@raycast/api';
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
