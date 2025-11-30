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
  ChromeLocalStorageUpdate
} from './websocket-types.js';

interface WebSocketServerOptions {
  port?: number;
  redis: Redis;
  token?: string;
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

  constructor(options: WebSocketServerOptions) {
    this.redis = options.redis;
    this.port = options.port ?? parseInt(process.env.WEBSOCKET_PORT || '9995');
    this.token = options.token;

    // Create HTTP server for Socket.IO
    this.httpServer = createServer();

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

      // Handle subscribe request
      socket.on('subscribe', async () => {
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

          // Group requests by domain
          const requestsByDomain = new Map<string, ChromeRequestLog[]>();
          for (const request of data) {
            try {
              const url = new URL(request.url);
              const domain = url.hostname;
              if (!requestsByDomain.has(domain)) {
                requestsByDomain.set(domain, []);
              }
              requestsByDomain.get(domain)!.push(request);
            } catch {
              // Skip invalid URLs
            }
          }

          // Update each domain's request list
          for (const [domain, requests] of requestsByDomain) {
            const key = REDIS_KEYS.CHROME_REQUESTS(domain);
            // Get existing requests for this domain
            const existing = await this.redis.get(key);
            let allRequests: ChromeRequestLog[] = [];
            if (existing) {
              try {
                allRequests = JSON.parse(existing);
              } catch {
                // Invalid JSON, start fresh
              }
            }
            // Prepend new requests and cap at 100 per domain
            allRequests = [...requests, ...allRequests].slice(0, 100);
            await this.redis.set(key, JSON.stringify(allRequests), 'EX', CHROME_DATA_TTL);
          }

          // Publish event for other listeners
          await this.redis.publish(
            REDIS_CHANNELS.CHROME_REQUESTS,
            JSON.stringify({ count: data.length, domains: Array.from(requestsByDomain.keys()), timestamp: Date.now() })
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
