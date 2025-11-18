import express, { Express } from 'express';
import { Server } from 'http';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// Logging utilities to match daemon format
function log(...args: any[]) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

function logError(...args: any[]) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}]`, ...args);
}

interface QueueInfo {
  name: string;
  prefix: string;
  fullName: string;
}

interface InstanceEnvConfig {
  queuePrefix?: string;
  redisUrl: string;
}

interface ActiveInstance {
  queues: Queue[];
  adapter: ExpressAdapter;
  queuePrefix?: string;
}

/**
 * Bull Board server for displaying BullMQ queues per workstream instance
 */
export class BullBoardServer {
  private app: Express;
  private server?: Server;
  private activeInstances: Map<string, ActiveInstance> = new Map();
  private port: number;

  constructor(port: number = 9999) {
    this.port = port;
    this.app = express();
    this.setupRoutes();
  }

  /**
   * Parse .env files from an instance directory to extract BullMQ configuration
   */
  private async parseInstanceEnv(instancePath: string): Promise<InstanceEnvConfig> {
    const config: InstanceEnvConfig = {
      redisUrl: 'redis://localhost:6379', // Default Redis URL
    };

    // Common .env file locations in a typical monorepo structure
    const envLocations = [
      path.join(instancePath, 'apps/api/.env'),
      path.join(instancePath, 'apps/server/.env'),
      path.join(instancePath, '.env'),
      path.join(instancePath, 'api/.env'),
    ];

    for (const envPath of envLocations) {
      if (fs.existsSync(envPath)) {
        try {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const lines = envContent.split('\n');

          for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip comments and empty lines
            if (!trimmedLine || trimmedLine.startsWith('#')) {
              continue;
            }

            // Parse BULLMQ_QUEUE_PREFIX
            if (trimmedLine.startsWith('BULLMQ_QUEUE_PREFIX=')) {
              const value = trimmedLine.split('=')[1]?.trim().replace(/['"]/g, '');
              if (value) {
                config.queuePrefix = value;
              }
            }

            // Parse REDIS_URL (optional override)
            if (trimmedLine.startsWith('REDIS_URL=')) {
              const value = trimmedLine.split('=')[1]?.trim().replace(/['"]/g, '');
              if (value) {
                config.redisUrl = value;
              }
            }
          }

          // If we found a queue prefix, we can return early
          if (config.queuePrefix) {
            return config;
          }
        } catch (error) {
          logError(`Error reading env file ${envPath}:`, error);
        }
      }
    }

    return config;
  }

  /**
   * Discover all BullMQ queues with a given prefix in Redis
   */
  private async discoverQueues(
    redisUrl: string,
    queuePrefix?: string
  ): Promise<QueueInfo[]> {
    const urlObj = new URL(redisUrl);
    const redis = new Redis({
      host: urlObj.hostname,
      port: parseInt(urlObj.port || '6379'),
      db: urlObj.pathname ? parseInt(urlObj.pathname.substring(1)) || 0 : 0,
    });
    const queues = new Set<string>();

    try {
      const scanPatterns = queuePrefix
        ? [`bull:${queuePrefix}:*`, `bull:${queuePrefix}_*`]
        : ['bull:*'];

      for (const scanPattern of scanPatterns) {
        let cursor = '0';
        do {
          const [newCursor, keys] = await redis.scan(
            cursor,
            'MATCH',
            scanPattern,
            'COUNT',
            100
          );
          cursor = newCursor;

          for (const key of keys) {
            const parts = key.split(':');

            if (parts.length >= 2 && parts[0] === 'bull') {
              let queueName: string | null = null;

              if (queuePrefix) {
                // Pattern 1: bull:{prefix}:{queueName}:{suffix}
                if (parts[1] === queuePrefix && parts[2]) {
                  queueName = parts[2];
                }
                // Pattern 2: bull:{prefix}_{queueName}:{suffix}
                else if (parts[1].startsWith(`${queuePrefix}_`)) {
                  const afterPrefix = parts[1].substring(queuePrefix.length + 1);
                  if (afterPrefix) {
                    queueName = afterPrefix;
                  }
                }
              } else {
                if (parts[1]) {
                  const underscoreIndex = parts[1].lastIndexOf('_');
                  if (underscoreIndex > 0 && parts[2]) {
                    queueName = parts[1].substring(underscoreIndex + 1);
                  } else {
                    const knownSuffixes = ['id', 'meta', 'wait', 'active', 'completed', 'failed', 'delayed', 'paused', 'repeat', 'events', 'stalled', 'limiter'];

                    if (parts[2] && !knownSuffixes.includes(parts[2])) {
                      queueName = parts[2];
                    } else {
                      queueName = parts[1];
                    }
                  }
                }
              }

              if (queueName) {
                queues.add(queueName);
              }
            }
          }
        } while (cursor !== '0');
      }

      const knownSuffixes = new Set(['id', 'meta', 'wait', 'active', 'completed', 'failed', 'delayed', 'paused', 'repeat', 'events', 'stalled', 'limiter', 'pc', 'marker']);
      const validQueues = Array.from(queues).filter(q => !knownSuffixes.has(q));

      return validQueues.map(name => ({
        name,
        prefix: queuePrefix || '',
        fullName: queuePrefix ? `${queuePrefix}_${name}` : name,
      }));
    } finally {
      await redis.quit();
    }
  }

  /**
   * Get common/default queue names to try if discovery returns no results
   */
  private getDefaultQueueNames(): string[] {
    return [
      'default',
      'email',
      'notifications',
      'jobs',
      'tasks',
      'background',
      'priority',
    ];
  }

  /**
   * Create bull-board for a specific instance
   */
  private async createInstanceBoard(instancePath: string, instanceKey: string): Promise<ExpressAdapter> {
    try {
      // Parse env config from instance
      const envConfig = await this.parseInstanceEnv(instancePath);
      log(`\n=== Setting up Bull Board instance ===`);
      log(`Instance: ${instancePath}`);
      log(`Queue Prefix: ${envConfig.queuePrefix || '(none)'}`);
      log(`Redis URL: ${envConfig.redisUrl}`);

      // Discover queues
      let queueInfos = await this.discoverQueues(envConfig.redisUrl, envConfig.queuePrefix);

      // If no queues discovered, try default queue names
      if (queueInfos.length === 0) {
        log('No queues discovered, trying default queue names...');
        const defaultNames = this.getDefaultQueueNames();
        queueInfos = defaultNames.map(name => ({
          name,
          prefix: envConfig.queuePrefix || '',
          fullName: envConfig.queuePrefix ? `${envConfig.queuePrefix}_${name}` : name,
        }));
      }

      log(`Found ${queueInfos.length} queues:`, queueInfos.map(q => q.name).join(', '));

      // Create Queue instances
      const redisUrlObj = new URL(envConfig.redisUrl);
      const queues = queueInfos.map(queueInfo => {
        const fullQueueName = envConfig.queuePrefix
          ? `${envConfig.queuePrefix}_${queueInfo.name}`
          : queueInfo.name;

        const queue = new Queue(fullQueueName, {
          connection: {
            host: redisUrlObj.hostname,
            port: parseInt(redisUrlObj.port || '6379'),
            db: redisUrlObj.pathname ? parseInt(redisUrlObj.pathname.substring(1)) || 0 : 0,
          },
          prefix: 'bull',
        });

        // Override the queue name for display
        Object.defineProperty(queue, 'name', {
          value: queueInfo.name,
          writable: false,
          enumerable: true,
          configurable: false,
        });

        return queue;
      });

      // Clean up any existing queues for this instance
      const existingInstance = this.activeInstances.get(instanceKey);
      if (existingInstance) {
        await Promise.all(existingInstance.queues.map(q => q.close()));
      }

      // Create adapters for bull-board
      const adapters = queues.map((queue) =>
        new BullMQAdapter(queue, {
          readOnlyMode: false,
          allowRetries: true,
        })
      );

      // Extract a friendly display name from the instance path
      const displayName = instancePath.split('/').pop() || instanceKey;

      // Create a new ExpressAdapter for this instance
      const serverAdapter = new ExpressAdapter();
      serverAdapter.setBasePath(`/i/${instanceKey}`);

      // Create the board with custom options
      createBullBoard({
        queues: adapters,
        serverAdapter,
        options: {
          uiConfig: {
            boardTitle: `${displayName}`,
            boardLogo: {
              path: '',
              width: 0,
              height: 0,
            },
          },
        },
      });

      // Store instance data
      this.activeInstances.set(instanceKey, {
        queues,
        adapter: serverAdapter,
        queuePrefix: envConfig.queuePrefix,
      });

      log(`✅ Bull Board created at /i/${instanceKey}`);
      log(`   Queues: ${queueInfos.map(q => q.name).join(', ')}`);

      return serverAdapter;
    } catch (error) {
      logError('Error creating instance board:', error);
      throw error;
    }
  }

  /**
   * Resolve instance name to path from Redis cache
   */
  private async resolveInstanceName(instanceName: string): Promise<string | null> {
    try {
      const redis = new Redis({
        host: 'localhost',
        port: 6379,
        lazyConnect: true,
        retryStrategy: () => null,
      });

      await redis.connect();
      const paths = await redis.smembers('workstream:instances:list');
      await redis.quit();

      if (paths && paths.length > 0) {
        // Find instance by name
        for (const instancePath of paths) {
          const name = instancePath.split('/').pop() || '';
          if (name.toLowerCase() === instanceName.toLowerCase()) {
            return instancePath;
          }
        }
      }
    } catch (error) {
      logError('Failed to resolve instance name:', error);
    }
    return null;
  }

  /**
   * Resolve instance identifier to a full path
   */
  private async resolveInstanceIdentifier(identifier: string): Promise<string> {
    // Check if it looks like a base64-encoded path
    try {
      const decoded = Buffer.from(identifier, 'base64').toString('utf-8');
      if (decoded.startsWith('/') || decoded.startsWith('~')) {
        log(`Detected base64-encoded path: ${decoded}`);
        return decoded;
      }
    } catch (error) {
      // Not base64, continue to name resolution
    }

    // Otherwise, treat it as an instance name
    log(`Resolving instance name: ${identifier}`);
    const resolvedPath = await this.resolveInstanceName(identifier);

    if (!resolvedPath) {
      throw new Error(`Instance not found: ${identifier}. Make sure the instance exists in your workspace.`);
    }

    return resolvedPath;
  }

  /**
   * Setup express routes for bull-board
   */
  private setupRoutes(): void {
    // Redirect root to help page
    this.app.get('/', async (req, res) => {
      const instanceParam = req.query.instance as string;

      if (instanceParam) {
        return res.redirect(`/i/${instanceParam}`);
      }

      // Show help page
      res.send(`
        <html>
          <head><title>Workstream Bull Board</title></head>
          <body style="font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px;">
            <h1>🚀 Workstream Bull Board</h1>
            <p>Instance-aware queue dashboard for BullMQ.</p>

            <h2>Usage</h2>
            <p>Open from Raycast:</p>
            <ol>
              <li>Select an instance in Workstream</li>
              <li>Press <kbd>⌘ + Q</kbd> to open the queue dashboard</li>
            </ol>

            <p>Or access directly by instance name:</p>
            <pre>http://localhost:${this.port}?instance={instance-name}</pre>

            <h2>Active Instances</h2>
            <p>Currently tracking <strong>${this.activeInstances.size}</strong> instance(s).</p>
            ${Array.from(this.activeInstances.entries()).map(([key, data]) => {
              let displayName = key;
              try {
                const decoded = Buffer.from(key, 'base64').toString('utf-8');
                if (decoded.startsWith('/') || decoded.startsWith('~')) {
                  displayName = decoded.split('/').pop() || key;
                }
              } catch {
                displayName = key;
              }
              return `
                <div style="margin: 10px 0; padding: 10px; background: #f5f5f5; border-radius: 5px;">
                  <a href="/i/${key}" style="text-decoration: none; color: #0066cc;">
                    <strong>${displayName}</strong>
                  </a>
                  <br/>
                  <small style="color: #666;">Prefix: ${data.queuePrefix || 'none'} | Queues: ${data.queues.length}</small>
                </div>
              `;
            }).join('')}
          </body>
        </html>
      `);
    });

    // Dynamic instance board route
    this.app.use('/i/:instanceKey', async (req, res, next) => {
      const instanceKey = req.params.instanceKey;

      let instance = this.activeInstances.get(instanceKey);

      if (!instance) {
        try {
          const instancePath = await this.resolveInstanceIdentifier(instanceKey);
          await this.createInstanceBoard(instancePath, instanceKey);
          instance = this.activeInstances.get(instanceKey)!;
        } catch (error) {
          logError('Error setting up board for instance:', error);
          return res.status(500).send(`
            <html>
              <head><title>Error</title></head>
              <body style="font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px;">
                <h1>❌ Error Loading Instance</h1>
                <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
                <a href="/">← Back to home</a>
              </body>
            </html>
          `);
        }
      }

      instance.adapter.getRouter()(req, res, next);
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        activeInstances: this.activeInstances.size,
        instances: Array.from(this.activeInstances.entries()).map(([key, data]) => {
          let path = key;
          try {
            path = Buffer.from(key, 'base64').toString('utf-8');
          } catch {
            // Not base64, use key as-is
          }
          return {
            path,
            queueCount: data.queues.length,
            queuePrefix: data.queuePrefix,
          };
        }),
      });
    });
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        log(`📊 Bull Board running on http://localhost:${this.port}`);
        log(`   Open with: http://localhost:${this.port}?instance={instance-name}`);
        log(`   Or use Raycast: Select instance and press ⌘+Q`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server and cleanup resources
   */
  async stop(): Promise<void> {
    // Close all queue connections
    for (const instance of this.activeInstances.values()) {
      await Promise.all(instance.queues.map(q => q.close()));
    }
    this.activeInstances.clear();

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}
