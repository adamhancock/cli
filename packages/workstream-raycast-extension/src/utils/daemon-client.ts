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
export async function loadFromDaemon(): Promise<DaemonCache | null> {
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
    return cache;
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

/**
 * Subscribe to real-time updates from the daemon via WebSocket
 * Returns a cleanup function to close the connection
 */
export function subscribeToUpdates(
  onUpdate: (instances: InstanceWithStatus[], timestamp?: number) => void,
  onError?: () => void
): () => void {
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let isClosing = false;

  const connect = () => {
    if (isClosing) return;

    try {
      ws = new WebSocket(DAEMON_WS_URL);

      ws.on('open', () => {
        console.log('WebSocket connected to daemon');
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'instances' && message.data) {
            console.log(`Received update: ${message.data.length} instances`);

            // Try to get the timestamp from the cache file
            let timestamp: number | undefined;
            try {
              const cacheContent = await readFile(DAEMON_CACHE_FILE, 'utf-8');
              const cache: DaemonCache = JSON.parse(cacheContent);
              timestamp = cache.timestamp;
            } catch {
              // If we can't read the cache, use current time
              timestamp = Date.now();
            }

            onUpdate(message.data, timestamp);
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        onError?.();
      });

      ws.on('close', () => {
        console.log('WebSocket disconnected');
        // Attempt to reconnect after 5 seconds if not intentionally closing
        if (!isClosing) {
          reconnectTimer = setTimeout(() => {
            console.log('Attempting to reconnect...');
            connect();
          }, 5000);
        }
      });
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      onError?.();
      // Try to reconnect after 5 seconds
      if (!isClosing) {
        reconnectTimer = setTimeout(connect, 5000);
      }
    }
  };

  // Start initial connection
  connect();

  // Return cleanup function
  return () => {
    isClosing = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      // Remove all event listeners first to prevent any events from firing during/after cleanup
      ws.removeAllListeners();

      // Check readyState before closing to avoid "WebSocket was closed before the connection was established" error
      // CONNECTING (0): Connection has not yet been established
      // OPEN (1): Connection is open and ready to communicate
      // CLOSING (2): Connection is in the process of closing
      // CLOSED (3): Connection is closed
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      // For CONNECTING state, don't call close() or terminate() - both throw errors
      // Just abandon the connection by setting isClosing=true and removing listeners
      // The underlying connection will be garbage collected
      ws = null;
    }
  };
}
