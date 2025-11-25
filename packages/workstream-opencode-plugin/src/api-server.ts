/**
 * OpenCode Plugin API Server
 * 
 * Exposes a simple HTTP API for the workstream daemon to poll
 * for accurate OpenCode status information.
 * 
 * Each OpenCode instance registers itself with a unique key based on
 * workspace path + PID, allowing multiple instances per workspace.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { getRedisClient } from './redis-client.ts';

// Redis key prefix for API server registrations
// Format: workstream:opencode:api:{base64(workspacePath)}:{pid}
const REDIS_KEY_PREFIX = 'workstream:opencode:api:';

// Redis key for listing all instances for a workspace
// Format: workstream:opencode:instances:{base64(workspacePath)}
const REDIS_INSTANCES_PREFIX = 'workstream:opencode:instances:';

export interface OpenCodeApiStatus {
  sessionId: string | null;
  workspacePath: string;
  projectName: string;
  pid: number;
  status: 'working' | 'waiting' | 'idle' | 'finished' | 'error';
  isWorking: boolean;
  isWaiting: boolean;
  isIdle: boolean;
  lastActivityTime: number;
  workStartedAt: number | null;
  metrics: {
    toolsUsed: Record<string, number>;
    filesEdited: number;
    commandsRun: number;
  };
}

export class ApiServer {
  private server: Server | null = null;
  private port: number = 0;
  private workspacePath: string;
  private pid: number;
  private statusGetter: () => OpenCodeApiStatus;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(workspacePath: string, statusGetter: () => OpenCodeApiStatus) {
    this.workspacePath = workspacePath;
    this.pid = process.pid;
    this.statusGetter = statusGetter;
  }

  /**
   * Start the API server on a random available port
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      // Listen on port 0 to get a random available port
      this.server.listen(0, '127.0.0.1', async () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          
          // Register this instance in Redis
          await this.registerInstance();
          
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    // Clear refresh interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    
    // Unregister from Redis
    await this.unregisterInstance();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get Redis key for this instance
   */
  private getInstanceKey(): string {
    const workspaceKey = Buffer.from(this.workspacePath).toString('base64');
    return `${REDIS_KEY_PREFIX}${workspaceKey}:${this.pid}`;
  }

  /**
   * Get Redis key for workspace instances set
   */
  private getInstancesSetKey(): string {
    const workspaceKey = Buffer.from(this.workspacePath).toString('base64');
    return `${REDIS_INSTANCES_PREFIX}${workspaceKey}`;
  }

  /**
   * Register this instance in Redis for daemon discovery
   */
  private async registerInstance(): Promise<void> {
    try {
      const redis = getRedisClient();
      const instanceKey = this.getInstanceKey();
      const instancesSetKey = this.getInstancesSetKey();
      
      const instanceData = JSON.stringify({
        port: this.port,
        workspacePath: this.workspacePath,
        pid: this.pid,
        registeredAt: Date.now(),
      });
      
      // Store instance data with TTL
      await redis.set(instanceKey, instanceData, 'EX', 60); // 60 second TTL
      
      // Add to set of instances for this workspace
      await redis.sadd(instancesSetKey, String(this.pid));
      await redis.expire(instancesSetKey, 3600); // 1 hour TTL for the set
      
      // Start refresh interval
      this.startRefreshInterval();
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Unregister this instance from Redis
   */
  private async unregisterInstance(): Promise<void> {
    try {
      const redis = getRedisClient();
      const instanceKey = this.getInstanceKey();
      const instancesSetKey = this.getInstancesSetKey();
      
      // Remove instance data
      await redis.del(instanceKey);
      
      // Remove from set of instances
      await redis.srem(instancesSetKey, String(this.pid));
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Refresh registration periodically
   */
  private startRefreshInterval(): void {
    // Refresh every 30 seconds (well before 60s TTL expires)
    this.refreshInterval = setInterval(async () => {
      try {
        const redis = getRedisClient();
        const instanceKey = this.getInstanceKey();
        const instancesSetKey = this.getInstancesSetKey();
        
        const instanceData = JSON.stringify({
          port: this.port,
          workspacePath: this.workspacePath,
          pid: this.pid,
          registeredAt: Date.now(),
        });
        
        await redis.set(instanceKey, instanceData, 'EX', 60);
        await redis.sadd(instancesSetKey, String(this.pid));
      } catch (error) {
        // Silent fail
      }
    }, 30000);
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);

    if (req.method === 'GET' && url.pathname === '/status') {
      this.handleStatusRequest(res);
    } else if (req.method === 'GET' && url.pathname === '/health') {
      this.handleHealthRequest(res);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Handle GET /status request
   */
  private handleStatusRequest(res: ServerResponse): void {
    try {
      const status = this.statusGetter();
      res.statusCode = 200;
      res.end(JSON.stringify(status));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get status' }));
    }
  }

  /**
   * Handle GET /health request
   */
  private handleHealthRequest(res: ServerResponse): void {
    res.statusCode = 200;
    res.end(JSON.stringify({ 
      ok: true, 
      workspacePath: this.workspacePath,
      pid: this.pid,
      port: this.port,
      uptime: process.uptime(),
    }));
  }

  /**
   * Get the current port
   */
  getPort(): number {
    return this.port;
  }
}
