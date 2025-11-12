import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import WebSocket from 'ws';
import type { InstanceWithStatus } from '../types';

const DAEMON_CACHE_FILE = join(homedir(), '.workstream-daemon', 'instances.json');
const DAEMON_WS_URL = 'ws://localhost:58234';

export interface DaemonCache {
  instances: InstanceWithStatus[];
  timestamp: number;
}

/**
 * Try to load instances from the daemon cache
 * Returns null if daemon is not running or cache is not available
 */
export async function loadFromDaemon(): Promise<InstanceWithStatus[] | null> {
  try {
    const content = await readFile(DAEMON_CACHE_FILE, 'utf-8');
    const cache: DaemonCache = JSON.parse(content);

    // Check if cache is recent (within last 10 minutes)
    const age = Date.now() - cache.timestamp;
    if (age > 600000) {
      console.log('Daemon cache is stale, falling back to direct fetch');
      return null;
    }

    console.log(`Loaded ${cache.instances.length} instances from daemon (age: ${age}ms)`);
    return cache.instances;
  } catch (error) {
    // Daemon not running or cache not available
    return null;
  }
}

/**
 * Trigger daemon to refresh instances immediately via WebSocket
 * Returns true if message was sent successfully
 */
export async function triggerDaemonRefresh(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DAEMON_WS_URL);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'refresh' }));
        ws.close();
        resolve(true);
      });

      ws.on('error', () => {
        resolve(false);
      });

      // Timeout after 1 second
      setTimeout(() => {
        ws.close();
        resolve(false);
      }, 1000);
    } catch {
      resolve(false);
    }
  });
}
