import Redis from 'ioredis';

export const REDIS_CHANNELS = {
  NOTIFICATIONS: 'workstream:notifications',
  GITHUB_ALIVE: 'workstream:github:alive',
  WORKTREE_UPDATES: 'workstream:worktree:updates',
  CHROME_CONSOLE: 'workstream:chrome:console',
  VSCODE_GIT: 'workstream:vscode:git',
  COMMANDS_BROADCAST: 'workstream:commands:broadcast',
  COMMANDS_INSTANCE: (hash: string) => `workstream:commands:${hash}`,
  COMMAND_RESULTS: 'workstream:command-results',
  REFRESH: 'workstream:refresh',
} as const;

export const REDIS_KEYS = {
  CHANNEL_INSTANCES: 'workstream:channel-instances',
  CHANNEL_INSTANCE: (hash: string) => `workstream:channel:${hash}`,
} as const;

export const CHANNEL_INSTANCE_TTL = 60; // 60s, refreshed periodically

let dataClient: Redis | null = null;
let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;

export function getDataClient(): Redis {
  if (!dataClient) {
    dataClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    dataClient.on('error', (err) => console.error('[Channel Redis] Data client error:', err));
  }
  return dataClient;
}

export function getPublisher(): Redis {
  if (!publisherClient) {
    publisherClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    publisherClient.on('error', (err) => console.error('[Channel Redis] Publisher error:', err));
  }
  return publisherClient;
}

export function getSubscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    subscriberClient.on('error', (err) => console.error('[Channel Redis] Subscriber error:', err));
  }
  return subscriberClient;
}

export function computeWorkspaceHash(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64');
}

export async function registerInstance(hash: string, workspacePath: string): Promise<void> {
  const data = getDataClient();
  const instanceData = JSON.stringify({
    hash,
    workspace: workspacePath,
    pid: process.pid,
    started_at: Date.now(),
  });

  await data.sadd(REDIS_KEYS.CHANNEL_INSTANCES, hash);
  await data.set(REDIS_KEYS.CHANNEL_INSTANCE(hash), instanceData, 'EX', CHANNEL_INSTANCE_TTL);
}

export async function refreshRegistration(hash: string): Promise<void> {
  const data = getDataClient();
  await data.expire(REDIS_KEYS.CHANNEL_INSTANCE(hash), CHANNEL_INSTANCE_TTL);
}

export async function deregisterInstance(hash: string): Promise<void> {
  const data = getDataClient();
  await data.srem(REDIS_KEYS.CHANNEL_INSTANCES, hash);
  await data.del(REDIS_KEYS.CHANNEL_INSTANCE(hash));
}

export function subscribeToChannels(
  hash: string,
  onMessage: (channel: string, message: string) => void,
): void {
  const sub = getSubscriber();

  const channels = [
    REDIS_CHANNELS.COMMANDS_INSTANCE(hash),
    REDIS_CHANNELS.COMMANDS_BROADCAST,
    REDIS_CHANNELS.NOTIFICATIONS,
    REDIS_CHANNELS.GITHUB_ALIVE,
    REDIS_CHANNELS.WORKTREE_UPDATES,
    REDIS_CHANNELS.CHROME_CONSOLE,
    REDIS_CHANNELS.VSCODE_GIT,
  ];

  sub.subscribe(...channels, (err) => {
    if (err) {
      console.error('[Channel Redis] Subscribe error:', err);
    } else {
      console.error(`[Channel] Subscribed to ${channels.length} Redis channels`);
    }
  });

  sub.on('message', onMessage);
}

export async function closeAll(): Promise<void> {
  const promises: Promise<unknown>[] = [];
  if (dataClient) { promises.push(dataClient.quit().catch(() => {})); dataClient = null; }
  if (publisherClient) { promises.push(publisherClient.quit().catch(() => {})); publisherClient = null; }
  if (subscriberClient) { promises.push(subscriberClient.quit().catch(() => {})); subscriberClient = null; }
  await Promise.all(promises);
}
