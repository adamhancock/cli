import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import { createServer } from 'http';
import Redis from 'ioredis';
import { REDIS_KEYS, REDIS_CHANNELS, CHROME_DATA_TTL } from './redis-client.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ClaudeEventData,
  NotificationData,
  ChromeCookieUpdate,
  ChromeRequestLog,
  ChromeLocalStorageUpdate,
  ChromeConsoleMessage
} from './websocket-types.js';

interface WebSocketServerOptions {
  port?: number;
  redis: Redis;
  token?: string;
  onActivity?: () => void; // Called when client connects or sends events
}

/**
 * WebSocket server for broadcasting workstream instance updates to connected clients
 * Runs on port 9995 by default
 */
export class WebSocketServer {
  private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  private httpServer: HTTPServer;
  private redis: Redis;
  private subscriber: Redis;
  private port: number;
  private token?: string;
  private connectedClients = 0;
  private onActivity?: () => void;

  constructor(options: WebSocketServerOptions) {
    this.redis = options.redis;
    this.port = options.port ?? parseInt(process.env.WEBSOCKET_PORT || '9995');
    this.token = options.token;
    this.onActivity = options.onActivity;

    // Create HTTP server for Socket.IO with request handling
    this.httpServer = createServer((req, res) => {
      // Handle POST /api/navigate for Chrome extension navigation
      if (req.method === 'POST' && req.url === '/api/navigate') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.url) {
              // Emit to all connected Chrome extensions
              this.io.emit('navigate', { url: data.url });
              console.log(`[WebSocket] Navigation request: ${data.url}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing url parameter' }));
            }
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // For other requests, let Socket.IO handle or return 404
      res.writeHead(404);
      res.end();
    });

    // Initialize Socket.IO server
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: '*', // Allow all origins for local network access
        methods: ['GET', 'POST']
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Add authentication middleware
    this.io.use((socket, next) => {
      if (this.token) {
        const clientToken = socket.handshake.auth.token;
        if (clientToken === this.token) {
          return next();
        }
        console.warn(`[WebSocket] Authentication failed for client ${socket.id}`);
        return next(new Error('Authentication error'));
      }
      return next();
    });

    // Create subscriber client for Redis pub/sub
    this.subscriber = new Redis({
      host: 'localhost',
      port: 6379,
    });

    this.setupSocketHandlers();
    this.setupRedisSubscriptions();
  }

  private setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      this.connectedClients++;
      console.log(`[WebSocket] Client connected (${this.connectedClients} total)`);

      // Mark activity when client connects
      this.onActivity?.();

      // Handle subscribe request
      socket.on('subscribe', async () => {
        // Mark activity when client subscribes
        this.onActivity?.();
        console.log('[WebSocket] Client subscribed to updates');
        // Send current instances immediately
        try {
          const instances = await this.loadAllInstances();
          socket.emit('instances', instances);
        } catch (error) {
          console.error('[WebSocket] Error loading instances:', error);
        }
      });

      // Handle get-instances request
      socket.on('get-instances', async () => {
        try {
          const instances = await this.loadAllInstances();
          socket.emit('instances', instances);
        } catch (error) {
          console.error('[WebSocket] Error loading instances:', error);
        }
      });

      // Handle ping
      socket.on('ping', () => {
        socket.emit('pong');
      });

      // Handle Chrome extension cookie updates
      socket.on('chrome:cookies', async (data: ChromeCookieUpdate) => {
        try {
          console.log(`[WebSocket] Received cookies for domain: ${data.domain}`);
          const key = REDIS_KEYS.CHROME_COOKIES(data.domain);
          await this.redis.set(key, JSON.stringify(data.cookies), 'EX', CHROME_DATA_TTL);
          // Publish event for other listeners
          await this.redis.publish(
            REDIS_CHANNELS.CHROME_COOKIES,
            JSON.stringify(data)
          );
        } catch (error) {
          console.error('[WebSocket] Error storing cookies:', error);
        }
      });

      // Handle Chrome extension request logs
      socket.on('chrome:requests', async (data: ChromeRequestLog[]) => {
        try {
          console.log(`[WebSocket] Received ${data.length} request logs`);

          // Group requests by domain:port
          const requestsByDestination = new Map<string, ChromeRequestLog[]>();
          for (const request of data) {
            try {
              const url = new URL(request.url);
              const domain = url.hostname;
              const port = url.port || (url.protocol === 'https:' ? '443' : '80');
              const destination = `${domain}:${port}`;
              if (!requestsByDestination.has(destination)) {
                requestsByDestination.set(destination, []);
              }
              requestsByDestination.get(destination)!.push(request);
            } catch {
              // Skip invalid URLs
            }
          }

          // Update each destination's request list
          for (const [destination, requests] of requestsByDestination) {
            const [domain, port] = destination.split(':');
            const key = REDIS_KEYS.CHROME_REQUESTS(domain, port);
            // Get existing requests for this destination
            const existing = await this.redis.get(key);
            let allRequests: ChromeRequestLog[] = [];
            if (existing) {
              try {
                allRequests = JSON.parse(existing);
              } catch {
                // Invalid JSON, start fresh
              }
            }
            // Prepend new requests and cap at 100 per destination
            allRequests = [...requests, ...allRequests].slice(0, 100);
            await this.redis.set(key, JSON.stringify(allRequests), 'EX', CHROME_DATA_TTL);
          }

          // Publish event for other listeners
          await this.redis.publish(
            REDIS_CHANNELS.CHROME_REQUESTS,
            JSON.stringify({ count: data.length, destinations: Array.from(requestsByDestination.keys()), timestamp: Date.now() })
          );
        } catch (error) {
          console.error('[WebSocket] Error storing request logs:', error);
        }
      });

      // Handle Chrome extension localStorage updates
      socket.on('chrome:localstorage', async (data: ChromeLocalStorageUpdate) => {
        try {
          console.log(`[WebSocket] Received localStorage for origin: ${data.origin}`);
          const key = REDIS_KEYS.CHROME_LOCALSTORAGE(data.origin);
          await this.redis.set(key, JSON.stringify(data.data), 'EX', CHROME_DATA_TTL);
          // Publish event for other listeners
          await this.redis.publish(
            REDIS_CHANNELS.CHROME_LOCALSTORAGE,
            JSON.stringify(data)
          );
        } catch (error) {
          console.error('[WebSocket] Error storing localStorage:', error);
        }
      });

      // Handle Chrome extension console messages
      socket.on('chrome:console', async (messages: ChromeConsoleMessage[]) => {
        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }

        try {
          console.log(`[WebSocket] Received ${messages.length} console messages`);
          const messagesByOrigin = new Map<string, ChromeConsoleMessage[]>();

          for (const message of messages) {
            if (!message?.origin) {
              continue;
            }
            if (!messagesByOrigin.has(message.origin)) {
              messagesByOrigin.set(message.origin, []);
            }
            messagesByOrigin.get(message.origin)!.push(message);
          }

          for (const [origin, originMessages] of messagesByOrigin) {
            const key = REDIS_KEYS.CHROME_CONSOLE(origin);
            const existing = await this.redis.get(key);
            let storedMessages: ChromeConsoleMessage[] = [];
            if (existing) {
              try {
                storedMessages = JSON.parse(existing);
              } catch {
                storedMessages = [];
              }
            }

            storedMessages = [...originMessages, ...storedMessages].slice(0, 200);
            await this.redis.set(key, JSON.stringify(storedMessages), 'EX', CHROME_DATA_TTL);
          }

          await this.redis.publish(
            REDIS_CHANNELS.CHROME_CONSOLE,
            JSON.stringify({
              count: messages.length,
              origins: Array.from(messagesByOrigin.keys()),
              timestamp: Date.now(),
            })
          );
        } catch (error) {
          console.error('[WebSocket] Error storing console messages:', error);
        }
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        this.connectedClients--;
        console.log(`[WebSocket] Client disconnected (${this.connectedClients} total)`);
      });
    });
  }

  private setupRedisSubscriptions() {
    // Subscribe to relevant channels
    this.subscriber.subscribe(
      REDIS_CHANNELS.UPDATES,
      REDIS_CHANNELS.CLAUDE,
      REDIS_CHANNELS.NOTIFICATIONS,
      (err) => {
        if (err) {
          console.error('[WebSocket] Failed to subscribe to Redis channels:', err);
        } else {
          console.log('[WebSocket] Subscribed to Redis pub/sub channels');
        }
      }
    );

    // Handle incoming pub/sub messages
    this.subscriber.on('message', async (channel, message) => {
      try {
        const data = JSON.parse(message);

        if (channel === REDIS_CHANNELS.UPDATES) {
          // Instance list updated - reload and broadcast all instances
          const instances = await this.loadAllInstances();
          this.io.emit('instances', instances);
        } else if (channel === REDIS_CHANNELS.CLAUDE) {
          // Claude event - forward to clients
          const claudeEvent: ClaudeEventData = {
            path: data.path,
            type: data.type,
            pid: data.pid,
            terminalName: data.terminalName,
            terminalId: data.terminalId,
            terminalPid: data.terminalPid,
            vscodePid: data.vscodePid,
            timestamp: data.timestamp || Date.now()
          };
          this.io.emit('claude-event', claudeEvent);
        } else if (channel === REDIS_CHANNELS.NOTIFICATIONS) {
          // Notification event - forward to clients
          const notification: NotificationData = {
            type: data.type,
            title: data.title,
            message: data.message,
            path: data.path,
            timestamp: data.timestamp || Date.now()
          };
          this.io.emit('notification', notification);
        }
      } catch (error) {
        console.error('[WebSocket] Error handling Redis message:', error);
      }
    });
  }

  private async loadAllInstances(): Promise<any[]> {
    try {
      // Get list of instance paths
      const paths = await this.redis.smembers(REDIS_KEYS.INSTANCES_LIST);

      if (paths.length === 0) {
        return [];
      }

      // Load all instances in parallel
      const pipeline = this.redis.pipeline();
      for (const path of paths) {
        const key = REDIS_KEYS.INSTANCE(path);
        pipeline.get(key);
      }

      const results = await pipeline.exec();

      if (!results) {
        return [];
      }

      // Parse and filter instances
      const instances = results
        .map(([err, data]) => {
          if (err || !data) return null;
          try {
            return JSON.parse(data as string);
          } catch {
            return null;
          }
        })
        .filter((instance): instance is any => instance !== null);

      return instances;
    } catch (error) {
      console.error('[WebSocket] Error loading instances:', error);
      return [];
    }
  }

  /**
   * Broadcast instances to all connected clients
   * Called by the daemon when instances are updated
   */
  async broadcastInstances(instances: any[]): Promise<void> {
    if (this.connectedClients > 0) {
      this.io.emit('instances', instances);
    }
  }

  /**
   * Broadcast a single instance update
   */
  async broadcastInstanceUpdate(instance: any): Promise<void> {
    if (this.connectedClients > 0) {
      this.io.emit('instance-updated', instance);
    }
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        console.log(`[WebSocket] Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    console.log('[WebSocket] Shutting down...');

    // Disconnect all clients
    this.io.disconnectSockets();

    // Close Socket.IO server
    this.io.close();

    // Close HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });

    // Unsubscribe and close Redis subscriber
    await this.subscriber.quit();

    console.log('[WebSocket] Server stopped');
  }

  /**
   * Get the number of connected clients
   */
  getConnectedClients(): number {
    return this.connectedClients;
  }
}
