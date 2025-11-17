import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import cors from 'cors';
import {
  InstanceWithMetadata,
  InstancesResponse,
  WebSocketMessage,
  VSCodeExtensionState,
  ChromeWindow,
} from './types.js';

const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

// Redis clients
const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  lazyConnect: true,
});

const redisSub = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  lazyConnect: true,
});

// Track connected WebSocket clients
const clients = new Set<WebSocket>();

// Utility to decode base64 path
function decodeBase64Path(base64Path: string): string {
  return Buffer.from(base64Path, 'base64').toString('utf-8');
}

// Utility to encode path to base64
function encodeBase64Path(path: string): string {
  return Buffer.from(path).toString('base64');
}

// Fetch all instances from Redis
async function fetchInstances(): Promise<InstancesResponse> {
  try {
    const instancePaths = await redisClient.smembers('workstream:instances:list');
    const timestamp = await redisClient.get('workstream:timestamp');

    const instances: InstanceWithMetadata[] = [];

    for (const path of instancePaths) {
      const base64Path = encodeBase64Path(path);
      const instanceKey = `workstream:instance:${base64Path}`;
      const extensionStateKey = `workstream:vscode:state:${base64Path}`;

      const [instanceData, extensionStateData] = await Promise.all([
        redisClient.get(instanceKey),
        redisClient.get(extensionStateKey),
      ]);

      if (instanceData) {
        const instance: InstanceWithMetadata = JSON.parse(instanceData);

        // Add extension state if available
        if (extensionStateData) {
          instance.extensionState = JSON.parse(extensionStateData) as VSCodeExtensionState;
        }

        instances.push(instance);
      }
    }

    return {
      instances,
      timestamp: timestamp ? parseInt(timestamp) : Date.now(),
    };
  } catch (error) {
    console.error('Error fetching instances:', error);
    return {
      instances: [],
      timestamp: Date.now(),
    };
  }
}

// Fetch Chrome windows from Redis
async function fetchChromeWindows(): Promise<ChromeWindow[]> {
  try {
    const data = await redisClient.get('workstream:chrome:windows');
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Error fetching Chrome windows:', error);
    return [];
  }
}

// Broadcast message to all connected WebSocket clients
function broadcast(message: WebSocketMessage) {
  const payload = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/instances', async (req, res) => {
  try {
    const data = await fetchInstances();
    res.json(data);
  } catch (error) {
    console.error('Error in /api/instances:', error);
    res.status(500).json({ error: 'Failed to fetch instances' });
  }
});

app.get('/api/chrome/windows', async (req, res) => {
  try {
    const windows = await fetchChromeWindows();
    res.json({ windows, timestamp: Date.now() });
  } catch (error) {
    console.error('Error in /api/chrome/windows:', error);
    res.status(500).json({ error: 'Failed to fetch Chrome windows' });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    await redisClient.publish('workstream:refresh', JSON.stringify({ type: 'refresh' }));
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/refresh:', error);
    res.status(500).json({ error: 'Failed to trigger refresh' });
  }
});

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket client connected');
  clients.add(ws);

  // Send initial data
  fetchInstances().then((data) => {
    const message: WebSocketMessage = {
      type: 'instances',
      data,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(message));
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });

  // Handle messages from client
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'refresh') {
        await redisClient.publish('workstream:refresh', JSON.stringify({ type: 'refresh' }));
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });
});

// Subscribe to Redis pub/sub channels
async function setupRedisSubscriptions() {
  await redisSub.subscribe(
    'workstream:updates',
    'workstream:refresh',
    'workstream:claude',
    'workstream:vscode:heartbeat',
    'workstream:chrome:updates',
    'workstream:notifications'
  );

  redisSub.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      // Broadcast update to all WebSocket clients
      const wsMessage: WebSocketMessage = {
        type: data.type || 'instances',
        data,
        timestamp: Date.now(),
      };

      // For instance updates, fetch fresh data
      if (channel === 'workstream:updates' || channel === 'workstream:vscode:heartbeat') {
        const instances = await fetchInstances();
        wsMessage.data = instances;
      }

      broadcast(wsMessage);
    } catch (error) {
      console.error(`Error handling Redis message from ${channel}:`, error);
    }
  });

  console.log('Subscribed to Redis pub/sub channels');
}

// Start server
async function start() {
  try {
    // Connect to Redis
    await redisClient.connect();
    await redisSub.connect();
    console.log(`Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);

    // Setup Redis subscriptions
    await setupRedisSubscriptions();

    // Start HTTP server
    server.listen(PORT, () => {
      console.log(`Workstream iPad API server running on http://localhost:${PORT}`);
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close();
  await redisClient.quit();
  await redisSub.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close();
  await redisClient.quit();
  await redisSub.quit();
  process.exit(0);
});

// Start the server
start();
