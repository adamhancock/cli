#!/usr/bin/env tsx

import { $ } from 'zx';
import { writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import Redis from 'ioredis';
import {
  getRedisClient,
  getPublisherClient,
  closeRedisConnections,
  REDIS_KEYS,
  REDIS_CHANNELS,
  INSTANCE_TTL,
  NOTION_TASKS_TTL
} from './redis-client.js';
import { fetchNotionTasks, isNotionConfigured, updateNotionTaskStatus, createNotionTask } from './notion-client.js';
import { spotlightMonitor } from './spotlight-monitor.js';
import { getEventStore, closeEventStore } from './event-store.js';
import { BullBoardServer } from './bull-board-server.js';
import { WebSocketServer } from './websocket-server.js';
import { getAuthToken } from './auth.js';
import { createWorktree } from './worktree-utils.js';

// Disable verbose output from zx
$.verbose = false;

interface VSCodeInstance {
  name: string;
  path: string;
  branch?: string;
  isGitRepo: boolean;
}

interface GitInfo {
  branch: string;
  isGitRepo: boolean;
  remoteBranch?: string;
  ahead?: number;
  behind?: number;
  isDirty: boolean;
  modified: number;
  staged: number;
  untracked: number;
}

interface PRCheck {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
}

interface PRStatus {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks?: {
    passing: number;
    failing: number;
    pending: number;
    total: number;
    conclusion: 'success' | 'failure' | 'pending';
    runs: PRCheck[];
  };
}

interface ClaudeSessionInfo {
  pid: number;
  status: 'working' | 'waiting' | 'idle' | 'finished' | 'checking' | 'compacting';
  terminalName?: string;  // VSCode terminal name (e.g., "bash", "zsh", "Terminal 1")
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  lastActivity: number;
  workStartedAt?: number;
  finishedAt?: number;
}

interface ClaudeStatus {
  sessions: Record<number, ClaudeSessionInfo>;  // Keyed by Claude PID
  primarySession?: number;  // PID of most recently active session

  // Legacy fields for backwards compatibility
  active: boolean;
  pid: number;
  isWorking: boolean;
  isWaiting?: boolean;
  isChecking?: boolean;
  isCompacting?: boolean;
  claudeFinished?: boolean;
  lastEventTime?: number;
  workStartedAt?: number;
  finishedAt?: number;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
}

interface TmuxStatus {
  name: string;
  exists: boolean;
}

interface CaddyHost {
  name: string;
  url: string;
  upstreams?: string[];
  worktreePath?: string;
  routes?: unknown[];
  isActive?: boolean;
}

interface SpotlightStatus {
  port: number;
  isOnline: boolean;
  errorCount: number;
  traceCount: number;
  logCount: number;
  lastChecked: number;
}

interface ChromeTab {
  index: number;
  title: string;
  url: string;
  favicon?: string;
}

interface ChromeWindow {
  id: number;
  tabs: ChromeTab[];
  lastUpdated: number;
}

interface VSCodeExtensionState {
  workspacePath: string;
  extensionVersion: string;
  vscodeVersion: string;
  vscodePid: number;
  window: {
    focused: boolean;
  };
  terminals: {
    total: number;
    active: number;
    pids: number[];
    names: string[];
    purposes: {
      devServer: number;
      testing: number;
      build: number;
      general: number;
    };
  };
  debug: {
    active: boolean;
    sessionCount: number;
    types: string[];
  };
  fileActivity: {
    lastSave: number;
    savesLast5Min: number;
    activeFile?: string;
    dirtyFileCount: number;
  };
  git: {
    branch?: string;
    lastCheckout?: {
      branch: string;
      timestamp: number;
    };
    lastCommit?: {
      timestamp: number;
    };
  };
  lastUpdated: number;
}

interface InstanceWithMetadata extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  spotlightStatus?: SpotlightStatus;
  extensionActive?: boolean;
  extensionVersion?: string;
  extensionState?: VSCodeExtensionState;
  lastUpdated: number;
  prLastUpdated?: number;
}

const CACHE_DIR = join(homedir(), '.workstream-daemon');
const CACHE_FILE = join(CACHE_DIR, 'instances.json');

// Dynamic polling intervals for battery optimization
const IDLE_POLL_INTERVAL = 60000;     // 60s when idle (no user activity)
const ACTIVE_POLL_INTERVAL = 10000;   // 10s when user is active
const ACTIVITY_TIMEOUT = 120000;      // Consider idle after 2min of no activity

// Separate poll intervals for expensive operations
const CHROME_POLL_INTERVAL = 120000;  // 2 minutes for Chrome tab enumeration
const SLOW_POLL_INTERVAL = 120000;    // 2 minutes for expensive process detection

// Legacy constants (kept for rate limiting logic)
const POLL_INTERVAL = 5000; // 5 seconds (git and Claude are local, fast) - replaced by dynamic polling
const MIN_POLL_INTERVAL = 120000; // 2 minutes (when rate limited)
// Rate limit protection tiers
const RATE_LIMIT_CRITICAL = 50;    // Stop all PR updates below this
const RATE_LIMIT_LOW = 200;        // Reduce PR frequency (5 min intervals)
const RATE_LIMIT_CAUTION = 500;    // Start being careful (2 min intervals)
const RATE_LIMIT_THRESHOLD = 100;  // Legacy threshold (kept for compatibility)

// Cache optimization
const CACHE_WRITE_DEBOUNCE = 30000;   // Write cache at most every 30 seconds

const CLAUDE_WORK_TIMEOUT = 5 * 60 * 1000; // 5 minutes - reset working state if no events
const CLAUDE_WAIT_TIMEOUT = 30 * 60 * 1000; // 30 minutes - reset waiting state if no events

function log(...args: any[]) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

function logError(...args: any[]) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}]`, ...args);
}

interface GitHubRateLimit {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

class WorkstreamDaemon {
  private instances: Map<string, InstanceWithMetadata> = new Map();
  private chromeWindows: ChromeWindow[] = [];
  private redis: Redis;
  private publisher: Redis;
  private subscriber: Redis;
  private pollTimer?: NodeJS.Timeout;
  private notionRefreshTimer?: NodeJS.Timeout;
  private currentPollInterval: number = ACTIVE_POLL_INTERVAL;
  private ghRateLimit?: GitHubRateLimit;
  private lastRateLimitCheck: number = 0;
  private previousPRStates: Map<string, { conclusion: 'success' | 'failure' | 'pending'; mergeable?: string }> = new Map();
  private bullBoard: BullBoardServer;
  private websocketServer?: WebSocketServer;

  // Activity tracking for dynamic polling
  private lastActivityTime: number = Date.now();
  private isUserActive: boolean = true;

  // Separate timers for expensive operations
  private chromeTimer?: NodeJS.Timeout;
  private slowPollTimer?: NodeJS.Timeout;

  // Cache write optimization
  private lastCacheWrite: number = 0;
  private lastCacheHash: string = '';

  // Rate limit protection - PR polling interval adjusts based on remaining rate limit
  private prPollInterval: number = 30000; // Default 30s between PR checks per instance
  private rateLimitPaused: boolean = false; // True when rate limit is critical

  constructor() {
    this.redis = getRedisClient();
    this.publisher = getPublisherClient();
    this.subscriber = new Redis({
      host: 'localhost',
      port: 6379,
    });
    this.setupSubscriber();

    // Initialize Bull Board server
    const bullBoardPort = parseInt(process.env.BULL_BOARD_PORT || '9999');
    this.bullBoard = new BullBoardServer(bullBoardPort);
  }

  /**
   * Mark user activity to adjust polling interval.
   * Called when clients connect, request data, or send events.
   */
  public markActivity() {
    this.lastActivityTime = Date.now();
    const wasIdle = !this.isUserActive;
    this.isUserActive = true;

    if (wasIdle) {
      log('🔄 User activity detected - switching to active polling');
      this.adjustPollInterval();
    }
  }

  /**
   * Calculate the current poll interval based on user activity.
   */
  private getDynamicPollInterval(): number {
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > ACTIVITY_TIMEOUT) {
      this.isUserActive = false;
      return IDLE_POLL_INTERVAL;
    }
    return ACTIVE_POLL_INTERVAL;
  }

  /**
   * Adjust the poll interval based on activity state.
   * Called when activity state changes.
   */
  private adjustPollInterval() {
    const newInterval = this.getDynamicPollInterval();
    if (newInterval !== this.currentPollInterval) {
      log(`⏱️  Poll interval changed: ${this.currentPollInterval}ms → ${newInterval}ms`);
      this.currentPollInterval = newInterval;

      // Reschedule the next poll with the new interval
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.scheduleNextPoll();
      }
    }
  }

  private setupSubscriber() {
    // Subscribe to refresh channel for general refresh requests
    this.subscriber.subscribe(REDIS_CHANNELS.REFRESH, (err) => {
      if (err) {
        logError('Failed to subscribe to refresh channel:', err);
      } else {
        log('Subscribed to refresh channel');
      }
    });

    // Subscribe to claude channel for Claude Code events
    this.subscriber.subscribe(REDIS_CHANNELS.CLAUDE, (err) => {
      if (err) {
        logError('Failed to subscribe to Claude channel:', err);
      } else {
        log('Subscribed to Claude channel');
      }
    });

    // Subscribe to VSCode heartbeat channel for instant state updates
    this.subscriber.subscribe(REDIS_CHANNELS.VSCODE_HEARTBEAT, (err) => {
      if (err) {
        logError('Failed to subscribe to VSCode heartbeat channel:', err);
      } else {
        log('Subscribed to VSCode heartbeat channel');
      }
    });

    // Subscribe to VSCode workspace events
    this.subscriber.subscribe(REDIS_CHANNELS.VSCODE_WORKSPACE, (err) => {
      if (err) {
        logError('Failed to subscribe to VSCode workspace channel:', err);
      } else {
        log('Subscribed to VSCode workspace channel');
      }
    });

    // Subscribe to VSCode file events
    this.subscriber.subscribe(REDIS_CHANNELS.VSCODE_FILE, (err) => {
      if (err) {
        logError('Failed to subscribe to VSCode file channel:', err);
      } else {
        log('Subscribed to VSCode file channel');
      }
    });

    // Subscribe to VSCode git events
    this.subscriber.subscribe(REDIS_CHANNELS.VSCODE_GIT, (err) => {
      if (err) {
        logError('Failed to subscribe to VSCode git channel:', err);
      } else {
        log('Subscribed to VSCode git channel');
      }
    });

    // Subscribe to VSCode terminal events
    this.subscriber.subscribe(REDIS_CHANNELS.VSCODE_TERMINAL, (err) => {
      if (err) {
        logError('Failed to subscribe to VSCode terminal channel:', err);
      } else {
        log('Subscribed to VSCode terminal channel');
      }
    });

    // Subscribe to notifications channel
    this.subscriber.subscribe(REDIS_CHANNELS.NOTIFICATIONS, (err) => {
      if (err) {
        logError('Failed to subscribe to notifications channel:', err);
      } else {
        log('Subscribed to notifications channel');
      }
    });

    // Subscribe to updates channel
    this.subscriber.subscribe(REDIS_CHANNELS.UPDATES, (err) => {
      if (err) {
        logError('Failed to subscribe to updates channel:', err);
      } else {
        log('Subscribed to updates channel');
      }
    });

    // Subscribe to Chrome updates channel
    this.subscriber.subscribe(REDIS_CHANNELS.CHROME_UPDATES, (err) => {
      if (err) {
        logError('Failed to subscribe to Chrome updates channel:', err);
      } else {
        log('Subscribed to Chrome updates channel');
      }
    });

    // Subscribe to worktree jobs channel
    this.subscriber.subscribe(REDIS_CHANNELS.WORKTREE_JOBS, (err) => {
      if (err) {
        logError('Failed to subscribe to worktree jobs channel:', err);
      } else {
        log('Subscribed to worktree jobs channel');
      }
    });

    // Subscribe to Notion tasks request channel
    this.subscriber.subscribe(REDIS_CHANNELS.NOTION_TASKS_REQUEST, (err) => {
      if (err) {
        logError('Failed to subscribe to Notion tasks request channel:', err);
      } else {
        log('Subscribed to Notion tasks request channel');
      }
    });

    // Subscribe to Notion status update request channel
    this.subscriber.subscribe(REDIS_CHANNELS.NOTION_UPDATE_STATUS_REQUEST, (err) => {
      if (err) {
        logError('Failed to subscribe to Notion status update channel:', err);
      } else {
        log('Subscribed to Notion status update channel');
      }
    });

    // Subscribe to Notion create task request channel
    this.subscriber.subscribe(REDIS_CHANNELS.NOTION_CREATE_TASK_REQUEST, (err) => {
      if (err) {
        logError('Failed to subscribe to Notion create task channel:', err);
      } else {
        log('Subscribed to Notion create task channel');
      }
    });

    this.subscriber.on('message', async (channel, message) => {
      try {
        const data = JSON.parse(message);
        // Log message type, or jobId for worktree jobs, or truncated message for others
        const messageInfo = data.type || data.jobId || JSON.stringify(data).substring(0, 50);
        log(`📨 Received message on ${channel}: ${messageInfo}`);

        // Store all events in the database
        await this.storeEvent(channel, message, data);

        // Mark activity on user-initiated events to switch to active polling
        // These channels indicate user/client interaction
        const activityChannels: string[] = [
          REDIS_CHANNELS.REFRESH,
          REDIS_CHANNELS.VSCODE_HEARTBEAT,
          REDIS_CHANNELS.VSCODE_FILE,
          REDIS_CHANNELS.VSCODE_GIT,
          REDIS_CHANNELS.NOTION_TASKS_REQUEST,
          REDIS_CHANNELS.WORKTREE_JOBS,
        ];
        if (activityChannels.includes(channel)) {
          this.markActivity();
        }

        if (channel === REDIS_CHANNELS.REFRESH) {
          // Handle general refresh requests
          if (data.type === 'refresh') {
            log('  🔄 Triggering forced PR refresh');
            this.pollInstances(true); // Force PR refresh
          }
        } else if (channel === REDIS_CHANNELS.CLAUDE) {
          // Handle Claude-specific events
          const projectName = data.path?.split('/').pop() || 'unknown';
          // Extract terminal context and Claude PID if available
          const claudePid = data.claudePid;
          const terminalName = data.terminalName;
          const terminalId = data.terminalId;
          const terminalPid = data.terminalPid;
          const vscodePid = data.vscodePid;

          // Use terminal name for display if available, otherwise use terminal ID
          const terminalInfo = terminalName || terminalId;

          if (data.type === 'work_started') {
            log(`  ▶️  Claude started working in ${projectName}${terminalInfo ? ` [${terminalInfo}]` : ''}${claudePid ? ` (PID: ${claudePid})` : ''}`);
            await this.handleClaudeStarted(data.path, claudePid, terminalName, terminalId, terminalPid, vscodePid);
          } else if (data.type === 'waiting_for_input') {
            log(`  ⏸️  Claude waiting for input in ${projectName}${terminalInfo ? ` [${terminalInfo}]` : ''}${claudePid ? ` (PID: ${claudePid})` : ''}`);
            await this.handleClaudeWaiting(data.path, claudePid, terminalName, terminalId, terminalPid, vscodePid);
          } else if (data.type === 'compacting_started') {
            log(`  🔄 Claude compacting context in ${projectName}${terminalInfo ? ` [${terminalInfo}]` : ''}${claudePid ? ` (PID: ${claudePid})` : ''}`);
            await this.handleClaudeCompacting(data.path, claudePid, terminalName, terminalId, terminalPid, vscodePid);
          } else if (data.type === 'work_stopped') {
            log(`  ⏹️  Claude stopped in ${projectName}${terminalInfo ? ` [${terminalInfo}]` : ''}${claudePid ? ` (PID: ${claudePid})` : ''}`);
            await this.handleClaudeFinished(data.path, claudePid, terminalName, terminalId, terminalPid, vscodePid);
          } else if (data.type === 'clear_finished') {
            log(`  🏁  Clearing finished flag for ${projectName}`);
            await this.handleClearFinished(data.path);
          }
        } else if (channel === REDIS_CHANNELS.VSCODE_HEARTBEAT) {
          // Handle VSCode heartbeat - immediately update that instance's state
          if (data.type === 'heartbeat' && data.workspacePath) {
            const projectName = data.workspacePath.split('/').pop() || 'unknown';
            log(`  💓 VSCode heartbeat from ${projectName}`);
            await this.handleVSCodeHeartbeat(data.workspacePath);
          }
        } else if (channel === REDIS_CHANNELS.WORKTREE_JOBS) {
          // Handle worktree job requests
          if (data.jobId && data.worktreeName && data.repoPath) {
            log(`  🌳 Worktree job received: ${data.worktreeName} (job: ${data.jobId})`);
            // Handle worktree job asynchronously (don't await to allow quick ack)
            this.handleWorktreeJob(data).catch((error) => {
              logError('Error handling worktree job:', error);
            });
          }
        } else if (channel === REDIS_CHANNELS.NOTIFICATIONS) {
          // Handle incoming notifications - send as system notification
          log(`  🔔 Notification: ${data.title} - ${data.message}`);
          await this.sendSystemNotification(data.title, data.message);
        } else if (channel === REDIS_CHANNELS.NOTION_TASKS_REQUEST) {
          // Handle Notion tasks request - fetch from Notion API and respond
          log('  📝 Notion tasks request received');

          if (!isNotionConfigured()) {
            log('  ⚠️ Notion not configured - missing env vars');
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_TASKS_RESPONSE,
              JSON.stringify({ success: false, error: 'Notion not configured', tasks: [] })
            );
          } else {
            try {
              const tasks = await fetchNotionTasks();
              // Cache tasks in Redis
              await this.redis.set(
                REDIS_KEYS.NOTION_TASKS,
                JSON.stringify(tasks),
                'EX',
                NOTION_TASKS_TTL
              );
              // Publish response
              await this.publisher.publish(
                REDIS_CHANNELS.NOTION_TASKS_RESPONSE,
                JSON.stringify({ success: true, tasks })
              );
              log(`  ✅ Notion tasks fetched and cached: ${tasks.length} tasks`);
            } catch (error) {
              logError('Failed to fetch Notion tasks:', error);
              await this.publisher.publish(
                REDIS_CHANNELS.NOTION_TASKS_RESPONSE,
                JSON.stringify({ success: false, error: String(error), tasks: [] })
              );
            }
          }
        } else if (channel === REDIS_CHANNELS.NOTION_UPDATE_STATUS_REQUEST) {
          // Handle Notion status update request
          const { pageId, statusName, requestId } = data;
          log(`  📝 Notion status update request: ${pageId} -> ${statusName || 'In Progress'}`);

          if (!isNotionConfigured()) {
            log('  ⚠️ Notion not configured - missing env vars');
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_UPDATE_STATUS_RESPONSE,
              JSON.stringify({ success: false, error: 'Notion not configured', requestId })
            );
          } else if (!pageId) {
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_UPDATE_STATUS_RESPONSE,
              JSON.stringify({ success: false, error: 'Missing pageId', requestId })
            );
          } else {
            const result = await updateNotionTaskStatus(pageId, statusName || 'In Progress');
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_UPDATE_STATUS_RESPONSE,
              JSON.stringify({ ...result, requestId })
            );
            if (result.success) {
              log(`  ✅ Notion task status updated: ${pageId}`);
              // Clear the tasks cache so next fetch gets updated status
              await this.redis.del(REDIS_KEYS.NOTION_TASKS);
            }
          }
        } else if (channel === REDIS_CHANNELS.NOTION_CREATE_TASK_REQUEST) {
          // Handle Notion task creation request
          const { title, requestId } = data;
          log(`  📝 Notion create task request: "${title}"`);

          if (!isNotionConfigured()) {
            log('  ⚠️ Notion not configured - missing env vars');
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_CREATE_TASK_RESPONSE,
              JSON.stringify({ success: false, error: 'Notion not configured', requestId })
            );
          } else if (!title || !title.trim()) {
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_CREATE_TASK_RESPONSE,
              JSON.stringify({ success: false, error: 'Title is required', requestId })
            );
          } else {
            const result = await createNotionTask(title.trim());
            await this.publisher.publish(
              REDIS_CHANNELS.NOTION_CREATE_TASK_RESPONSE,
              JSON.stringify({ ...result, requestId })
            );
            if (result.success) {
              log(`  ✅ Notion task created: ${result.task?.taskId || result.task?.id}`);
              // Clear the tasks cache so next fetch includes the new task
              await this.redis.del(REDIS_KEYS.NOTION_TASKS);
            }
          }
        }
      } catch (error) {
        logError('Error handling message:', error);
      }
    });
  }

  /**
   * Store an event in the database and publish to events channel
   */
  private async storeEvent(channel: string, message: string, data: any) {
    try {
      const eventStore = getEventStore();
      const timestamp = data.timestamp || Date.now();
      const eventType = data.type || 'unknown';
      const workspacePath = data.path || data.workspacePath || null;

      // Store event in database
      eventStore.storeEvent({
        timestamp,
        channel,
        event_type: eventType,
        workspace_path: workspacePath,
        data: message,
      });

      // Publish to events channel for real-time updates
      await this.publisher.publish(
        REDIS_CHANNELS.EVENTS_NEW,
        JSON.stringify({
          timestamp,
          channel,
          event_type: eventType,
          workspace_path: workspacePath,
          data: data,
        })
      );

      // Update Redis snapshot with recent events (last 100)
      const recentEvents = eventStore.getRecentEvents(100);
      await this.redis.set(
        REDIS_KEYS.EVENTS_RECENT,
        JSON.stringify(recentEvents),
        'EX',
        60 // 60 second TTL
      );
    } catch (error) {
      // Don't log errors for event storage to avoid spam
      // Events are nice-to-have, not critical
    }
  }

  private async publishUpdate() {
    try {
      const instances = Array.from(this.instances.values());
      const timestamp = Date.now();

      // Store each instance in Redis with TTL
      const pipeline = this.redis.pipeline();

      // Store instance paths list
      if (instances.length > 0) {
        pipeline.del(REDIS_KEYS.INSTANCES_LIST);
        for (const instance of instances) {
          pipeline.sadd(REDIS_KEYS.INSTANCES_LIST, instance.path);
        }
        pipeline.expire(REDIS_KEYS.INSTANCES_LIST, INSTANCE_TTL);
      }

      // Store each instance data
      for (const instance of instances) {
        const key = REDIS_KEYS.INSTANCE(instance.path);
        pipeline.set(key, JSON.stringify(instance), 'EX', INSTANCE_TTL);
      }

      // Store timestamp
      pipeline.set(REDIS_KEYS.TIMESTAMP, timestamp.toString(), 'EX', INSTANCE_TTL);

      await pipeline.exec();

      // Publish update notification
      await this.publisher.publish(
        REDIS_CHANNELS.UPDATES,
        JSON.stringify({
          type: 'instances',
          count: instances.length,
          timestamp,
        })
      );
    } catch (error) {
      logError('Error publishing update:', error);
    }
  }

  private async publishChromeUpdate() {
    try {
      const timestamp = Date.now();

      // Store Chrome windows in Redis with TTL
      await this.redis.set(
        REDIS_KEYS.CHROME_WINDOWS,
        JSON.stringify(this.chromeWindows),
        'EX',
        INSTANCE_TTL
      );

      // Publish update notification
      await this.publisher.publish(
        REDIS_CHANNELS.CHROME_UPDATES,
        JSON.stringify({
          type: 'chrome',
          windowCount: this.chromeWindows.length,
          tabCount: this.chromeWindows.reduce((sum, w) => sum + w.tabs.length, 0),
          timestamp,
        })
      );
    } catch (error) {
      logError('Error publishing Chrome update:', error);
    }
  }

  async start() {
    log('🚀 Workstream Daemon starting...');

    // Try to acquire the daemon lock with retry logic (2 minutes)
    const acquired = await this.acquireLockWithRetry();
    if (!acquired) {
      const existingPid = await this.redis.get(REDIS_KEYS.DAEMON_LOCK);
      log('❌ Unable to acquire daemon lock after 2 minutes');
      log(`   Another daemon (PID: ${existingPid}) is still running`);
      log('   Stop the existing daemon before starting a new one');
      throw new Error('Daemon already running');
    }

    // Ensure cache directory exists
    log('📁 Setting up cache directory...');
    await mkdir(CACHE_DIR, { recursive: true });

    // Check initial rate limit
    await this.checkGitHubRateLimit();
    if (this.ghRateLimit) {
      const percent = Math.round((this.ghRateLimit.remaining / this.ghRateLimit.limit) * 100);
      log(`🔍 GitHub Rate Limit: ${percent}% remaining (${this.ghRateLimit.remaining}/${this.ghRateLimit.limit})`);
    }

    // Initial poll
    log('🔄 Running initial poll...');
    await this.pollInstances();

    // Start polling with dynamic interval
    this.scheduleNextPoll();

    // Start slow poll timer for expensive operations (Chrome, Claude processes)
    this.startSlowPoll();

    // Start Chrome tab polling on separate timer
    this.startChromePoll();

    // Start Bull Board HTTP server
    log('📊 Starting Bull Board...');
    await this.bullBoard.start();

    // Initialize and start WebSocket server
    log('🔌 Starting WebSocket server...');
    const token = await getAuthToken();
    const websocketPort = parseInt(process.env.WEBSOCKET_PORT || '9995');
    this.websocketServer = new WebSocketServer({
      port: websocketPort,
      redis: this.redis,
      token,
      onActivity: () => this.markActivity()
    });
    await this.websocketServer.start();

    // Start background Notion task fetching (every 5 minutes)
    if (isNotionConfigured()) {
      log('📝 Starting background Notion task fetching...');
      // Fetch immediately on startup
      this.refreshNotionTasksCache();
      // Then fetch every 5 minutes
      this.notionRefreshTimer = setInterval(() => this.refreshNotionTasksCache(), 5 * 60 * 1000);
    }

    log('');
    log('✅ Daemon running');
    log(`   Main poll interval: ${ACTIVE_POLL_INTERVAL}ms (active) / ${IDLE_POLL_INTERVAL}ms (idle)`);
    log(`   Chrome poll interval: ${CHROME_POLL_INTERVAL}ms`);
    log(`   Slow poll interval: ${SLOW_POLL_INTERVAL}ms`);
    log(`   Cache file: ${CACHE_FILE}`);
    log(`   Auth Token: ${token}`);
    log(`   Redis channels:`);
    log(`     - Updates: ${REDIS_CHANNELS.UPDATES}`);
    log(`     - Refresh: ${REDIS_CHANNELS.REFRESH}`);
    log(`     - Claude: ${REDIS_CHANNELS.CLAUDE}`);
    log(`     - Chrome Updates: ${REDIS_CHANNELS.CHROME_UPDATES}`);
    log('');
  }

  private scheduleNextPoll() {
    // Check if we should switch to idle mode
    this.adjustPollInterval();

    this.pollTimer = setTimeout(() => {
      this.pollInstances()
        .catch(logError)
        .finally(() => {
          this.scheduleNextPoll();
        });
    }, this.currentPollInterval);
  }

  /**
   * Start the Chrome tab polling on a separate timer.
   * Chrome enumeration is expensive (AppleScript), so we do it less frequently.
   */
  private startChromePoll() {
    // Run initial Chrome poll
    this.pollChromeWindows().catch(logError);

    // Schedule recurring Chrome polls
    this.chromeTimer = setInterval(() => {
      this.pollChromeWindows().catch(logError);
    }, CHROME_POLL_INTERVAL);
  }

  /**
   * Poll Chrome windows separately from main poll.
   */
  private async pollChromeWindows() {
    try {
      const chromeWindows = await this.getChromeWindows();
      this.chromeWindows = chromeWindows;
      const tabCount = chromeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
      log(`🌐 [Chrome Poll] Found ${chromeWindows.length} windows with ${tabCount} tabs`);

      // Publish Chrome update
      await this.publishChromeUpdate();
    } catch (error) {
      logError('[Chrome Poll] Error:', error);
    }
  }

  /**
   * Start the slow poll timer for expensive operations.
   * This handles Claude process detection and lsof scans.
   */
  private startSlowPoll() {
    // Run initial slow poll
    this.slowPoll().catch(logError);

    // Schedule recurring slow polls
    this.slowPollTimer = setInterval(() => {
      this.slowPoll().catch(logError);
    }, SLOW_POLL_INTERVAL);
  }

  /**
   * Perform expensive operations that don't need to run every 10 seconds.
   * - Claude process detection (ps + lsof)
   * - Full VS Code instance enumeration via lsof
   */
  private async slowPoll() {
    try {
      log('🐢 [Slow Poll] Running expensive operations...');

      // Update Claude status for all instances
      for (const [path, instance] of this.instances) {
        if (instance.isGitRepo) {
          const claudeStatus = await this.getClaudeStatus(path);
          if (claudeStatus) {
            instance.claudeStatus = claudeStatus;
          }
        }
      }

      log('🐢 [Slow Poll] Complete');
    } catch (error) {
      logError('[Slow Poll] Error:', error);
    }
  }

  /**
   * Background refresh of Notion tasks cache
   * Runs every 5 minutes to ensure tasks are always available instantly
   */
  private async refreshNotionTasksCache() {
    try {
      log('[Notion] Background refresh: fetching tasks...');
      const tasks = await fetchNotionTasks();

      // Cache the tasks in Redis
      await this.redis.set(
        REDIS_KEYS.NOTION_TASKS,
        JSON.stringify(tasks),
        'EX',
        NOTION_TASKS_TTL
      );

      log(`[Notion] Background refresh: cached ${tasks.length} tasks`);
    } catch (error) {
      logError('[Notion] Background refresh failed:', error);
    }
  }

  async stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    if (this.chromeTimer) {
      clearInterval(this.chromeTimer);
    }

    if (this.slowPollTimer) {
      clearInterval(this.slowPollTimer);
    }

    if (this.notionRefreshTimer) {
      clearInterval(this.notionRefreshTimer);
    }

    // Stop WebSocket server
    if (this.websocketServer) {
      await this.websocketServer.stop();
    }

    // Stop Bull Board server
    await this.bullBoard.stop();

    // Disconnect all spotlight monitoring streams
    spotlightMonitor.disconnectAll();

    // Release the daemon lock
    await this.releaseLock();

    // Unsubscribe and close Redis connections
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    await closeRedisConnections();

    // Close event store database connection
    closeEventStore();

    log('Daemon stopped');
  }

  /**
   * Acquire the daemon lock using Redis SET NX (set if not exists)
   * Lock expires after 30 seconds if not refreshed
   */
  private async acquireLock(): Promise<boolean> {
    const pid = process.pid.toString();
    const result = await this.redis.set(REDIS_KEYS.DAEMON_LOCK, pid, 'EX', 30, 'NX');
    return result === 'OK';
  }

  /**
   * Try to acquire the daemon lock with retry logic (up to 2 minutes)
   * Checks if existing PID is still alive and waits for it to release
   */
  private async acquireLockWithRetry(): Promise<boolean> {
    const maxRetries = 60; // 60 retries * 2 seconds = 2 minutes
    const retryDelay = 2000; // 2 seconds

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Try to acquire the lock
      const acquired = await this.acquireLock();
      if (acquired) {
        if (attempt > 0) {
          log('✅ Successfully acquired daemon lock');
        }
        return true;
      }

      // Lock exists, check if the PID is still alive
      const existingPid = await this.redis.get(REDIS_KEYS.DAEMON_LOCK);
      if (existingPid) {
        const isAlive = await this.isProcessAlive(existingPid);

        if (!isAlive) {
          // Process is dead, forcefully acquire the lock
          log(`⚠️  Stale lock detected (PID ${existingPid} not running), acquiring lock`);
          await this.redis.del(REDIS_KEYS.DAEMON_LOCK);
          const acquired = await this.acquireLock();
          if (acquired) {
            return true;
          }
        } else {
          // Process is alive, wait and retry
          if (attempt === 0) {
            log(`⏳ Waiting for existing daemon (PID ${existingPid}) to release lock...`);
          } else if (attempt % 15 === 0) { // Log every 30 seconds
            const elapsed = attempt * retryDelay / 1000;
            const remaining = (maxRetries - attempt) * retryDelay / 1000;
            log(`   Still waiting... (${elapsed}s elapsed, ${remaining}s remaining)`);
          }
        }
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }

    return false;
  }

  /**
   * Check if a process is still running by PID
   */
  private async isProcessAlive(pid: string): Promise<boolean> {
    try {
      // Use kill -0 to check if process exists without actually killing it
      const result = await $`kill -0 ${pid} 2>/dev/null`.quiet();
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the lock TTL to prevent expiration while daemon is running
   */
  private async refreshLock(): Promise<void> {
    const pid = process.pid.toString();
    await this.redis.set(REDIS_KEYS.DAEMON_LOCK, pid, 'EX', 30, 'XX');
  }

  /**
   * Release the daemon lock on shutdown
   */
  private async releaseLock(): Promise<void> {
    await this.redis.del(REDIS_KEYS.DAEMON_LOCK);
  }

  private getMinutesUntilReset(resetTimestamp: number): number {
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const secondsUntilReset = resetTimestamp - now;
    return Math.ceil(secondsUntilReset / 60); // Convert to minutes, round up
  }

  private async checkGitHubRateLimit(): Promise<void> {
    try {
      const result = await $`/opt/homebrew/bin/gh api rate_limit`;
      const data = JSON.parse(result.stdout);

      // Monitor both core REST API and GraphQL API
      const coreLimit = data.resources.core;
      const graphqlLimit = data.resources.graphql;

      // Use the more restrictive limit
      const effectiveLimit = coreLimit.remaining < graphqlLimit.remaining ? coreLimit : graphqlLimit;
      this.ghRateLimit = effectiveLimit;
      this.lastRateLimitCheck = Date.now();

      const remaining = this.ghRateLimit!.remaining;
      const coreMinutesUntilReset = this.getMinutesUntilReset(coreLimit.reset);
      const graphqlMinutesUntilReset = this.getMinutesUntilReset(graphqlLimit.reset);
      const corePercent = Math.round((coreLimit.remaining / coreLimit.limit) * 100);
      const graphqlPercent = Math.round((graphqlLimit.remaining / graphqlLimit.limit) * 100);

      // Tiered rate limit protection
      if (remaining <= RATE_LIMIT_CRITICAL) {
        // CRITICAL: Stop all PR updates until reset
        this.rateLimitPaused = true;
        this.prPollInterval = Infinity; // Effectively disable PR polling
        log(`🛑 GitHub Rate Limit CRITICAL (${remaining} remaining) - PR updates PAUSED until reset`);
        log(`   Core: ${corePercent}% (${coreLimit.remaining}/${coreLimit.limit}), resets in ${coreMinutesUntilReset}m`);
        log(`   GraphQL: ${graphqlPercent}% (${graphqlLimit.remaining}/${graphqlLimit.limit}), resets in ${graphqlMinutesUntilReset}m`);
      } else if (remaining <= RATE_LIMIT_LOW) {
        // LOW: Very conservative - 5 minute PR intervals
        this.rateLimitPaused = false;
        this.prPollInterval = 5 * 60 * 1000; // 5 minutes
        log(`⚠️  GitHub Rate Limit LOW (${remaining} remaining) - PR updates every 5 minutes`);
        log(`   Core: ${corePercent}% (${coreLimit.remaining}/${coreLimit.limit}), resets in ${coreMinutesUntilReset}m`);
      } else if (remaining <= RATE_LIMIT_CAUTION) {
        // CAUTION: Moderate - 2 minute PR intervals
        this.rateLimitPaused = false;
        this.prPollInterval = 2 * 60 * 1000; // 2 minutes
        log(`⚡ GitHub Rate Limit CAUTION (${remaining} remaining) - PR updates every 2 minutes`);
      } else {
        // NORMAL: Standard 30 second PR intervals
        this.rateLimitPaused = false;
        this.prPollInterval = 30 * 1000; // 30 seconds
        // Don't log when normal
      }
    } catch (error) {
      // GitHub CLI not available or not authenticated
      log('Unable to check GitHub rate limit (gh CLI may not be available)');
      // Be conservative when we can't check
      this.rateLimitPaused = false;
      this.prPollInterval = 2 * 60 * 1000; // Default to 2 minutes when unknown
    }
  }

  private async pollInstances(forcePR: boolean = false) {
    try {
      log(`🔄 Starting poll${forcePR ? ' (forced PR refresh)' : ''}...`);

      // Refresh the daemon lock to prevent expiration
      await this.refreshLock();

      const instances = await this.getVSCodeInstances();
      log(`📁 Found ${instances.length} VS Code instances`);

      // Update instances map
      const newPaths = new Set(instances.map(i => i.path));

      // Remove instances that no longer exist
      let removedCount = 0;
      for (const [path] of this.instances) {
        if (!newPaths.has(path)) {
          this.instances.delete(path);
          removedCount++;

          // Disconnect spotlight monitoring for removed instance
          if (spotlightMonitor.isConnected(path)) {
            log(`  🔌 Disconnecting spotlight stream for removed instance: ${path.split('/').pop()}`);
            spotlightMonitor.disconnectStream(path);
          }

          log(`  ➖ Removed closed instance: ${path.split('/').pop()}`);
        }
      }

      // Log if we're skipping PR status due to rate limiting
      if (this.rateLimitPaused) {
        log('🛑 PR status updates PAUSED - rate limit below critical threshold');
      }

      // Update or add instances (in parallel for speed)
      const enrichmentTasks: Array<{
        instance: VSCodeInstance;
        shouldUpdatePR: boolean;
        projectName: string;
      }> = [];

      // Load any missing instances from Redis (for daemon restart scenario)
      const missingPaths = instances.filter(i => !this.instances.has(i.path)).map(i => i.path);
      if (missingPaths.length > 0) {
        log(`  📦 Loading ${missingPaths.length} instance(s) from Redis cache...`);
        const pipeline = this.redis.pipeline();
        for (const path of missingPaths) {
          pipeline.get(REDIS_KEYS.INSTANCE(path));
        }
        const results = await pipeline.exec();

        // Restore instances from Redis into memory
        let restoredCount = 0;
        if (results) {
          for (let i = 0; i < results.length; i++) {
            const [err, data] = results[i];
            if (!err && data) {
              try {
                const cached = JSON.parse(data as string) as InstanceWithMetadata;
                this.instances.set(missingPaths[i], cached);
                restoredCount++;
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
        if (restoredCount > 0) {
          log(`  ✅ Restored ${restoredCount} instance(s) with previous metadata (including PR refresh times)`);
        }
      }

      let skippedCount = 0;
      for (const instance of instances) {
        const existing = this.instances.get(instance.path);
        const projectName = instance.path.split('/').pop() || instance.path;

        // Always update git (local, no rate limits)
        const shouldUpdateLocal = !existing || (Date.now() - existing.lastUpdated) > 5000; // 5 seconds

        // PR updates respect rate limit protection
        // - Paused when rate limit is critical
        // - Uses dynamic prPollInterval based on remaining rate limit
        const timeSinceLastPR = Date.now() - (existing?.prLastUpdated || 0);
        const shouldUpdatePR = !this.rateLimitPaused && (
          forcePR ||
          !existing ||
          timeSinceLastPR > this.prPollInterval
        );

        if (shouldUpdateLocal) {
          enrichmentTasks.push({ instance, shouldUpdatePR, projectName });
        } else {
          skippedCount++;
        }
      }

      // Enrich all instances in parallel
      let updatedCount = 0;
      if (enrichmentTasks.length > 0) {
        const prUpdateCount = enrichmentTasks.filter(t => t.shouldUpdatePR).length;
        log(`  🔍 Enriching ${enrichmentTasks.length} instances in parallel...`);

        // Check rate limit only when we're about to make GitHub API calls
        // AND it's been more than 30 seconds since last check (or forced refresh)
        const timeSinceLastCheck = Date.now() - this.lastRateLimitCheck;
        if (prUpdateCount > 0 && (forcePR || timeSinceLastCheck > 30000)) {
          await this.checkGitHubRateLimit();
        }

        // Log rate limit info only when we're actually making GitHub API calls
        if (prUpdateCount > 0 && this.ghRateLimit) {
          const percent = Math.round((this.ghRateLimit.remaining / this.ghRateLimit.limit) * 100);
          log(`  📊 GitHub Rate Limit: ${percent}% remaining (${this.ghRateLimit.remaining}/${this.ghRateLimit.limit}), updating ${prUpdateCount} PR${prUpdateCount > 1 ? 's' : ''}`);
        }

        const enrichmentResults = await Promise.all(
          enrichmentTasks.map(async ({ instance, shouldUpdatePR, projectName }) => {
            try {
              const enriched = await this.enrichInstance(instance, shouldUpdatePR);
              // enriched is null if directory no longer exists
              return { success: true as const, enriched, projectName, shouldUpdatePR, path: instance.path };
            } catch (error) {
              logError(`  ❌ Failed to enrich ${projectName}:`, error);
              return { success: false as const, projectName, enriched: undefined, path: instance.path };
            }
          })
        );

        // Process results and update instances map
        for (const result of enrichmentResults) {
          if (result.success && result.enriched === null) {
            // Directory no longer exists - remove the stale instance
            log(`  🗑️  Removing stale instance: ${result.projectName}`);
            this.instances.delete(result.path);

            // Disconnect spotlight monitoring
            if (spotlightMonitor.isConnected(result.path)) {
              spotlightMonitor.disconnectStream(result.path);
            }

            // Remove from Redis
            await this.redis.del(REDIS_KEYS.INSTANCE(result.path));
            await this.redis.srem(REDIS_KEYS.INSTANCES_LIST, result.path);

            removedCount++;
          } else if (result.success && result.enriched) {
            this.instances.set(result.enriched.path, result.enriched);
            updatedCount++;

            // Log key status info
            const enriched = result.enriched;
            log(`  ✅ ${result.projectName}${result.shouldUpdatePR ? ' (with PR)' : ''}`);
            if (enriched.gitInfo) {
              log(`     📊 Git: ${enriched.gitInfo.branch}${enriched.gitInfo.isDirty ? ' (dirty)' : ' (clean)'}`);
            }
            if (enriched.prStatus) {
              log(`     🔀 PR #${enriched.prStatus.number}: ${enriched.prStatus.state}`);
            }
            if (enriched.claudeStatus?.active) {
              const claudeState = enriched.claudeStatus.isWaiting ? 'waiting' : enriched.claudeStatus.isWorking ? 'working' : 'idle';
              log(`     🤖 Claude: ${claudeState} (pid ${enriched.claudeStatus.pid})`);
            }
            if (enriched.caddyHost) {
              log(`     🌐 Caddy: ${enriched.caddyHost.url}`);
            }
          }
        }
      }

      // Chrome windows are now polled separately on a 2-minute timer
      // (see startChromePoll method)

      // Write to cache file with debouncing (for compatibility)
      const cacheWritten = await this.writeCacheDebounced();
      if (cacheWritten) {
        log(`💾 Wrote cache file`);
      }

      // Publish to Redis
      await this.publishUpdate();
      log(`📡 Published ${this.instances.size} instances to Redis`);

      log(`✅ Poll complete: ${updatedCount} updated, ${skippedCount} skipped, ${removedCount} removed`);
    } catch (error) {
      logError('Error polling instances:', error);
    }
  }

  /**
   * Write cache with debouncing and hash-based change detection.
   * Only writes if data has changed and enough time has passed since last write.
   * @returns true if cache was written, false if skipped
   */
  private async writeCacheDebounced(): Promise<boolean> {
    const now = Date.now();
    const timeSinceLastWrite = now - this.lastCacheWrite;

    // Skip if we wrote too recently
    if (timeSinceLastWrite < CACHE_WRITE_DEBOUNCE) {
      return false;
    }

    const data = {
      instances: Array.from(this.instances.values()),
      timestamp: now,
    };

    // Create a hash of the data (excluding timestamp) to detect changes
    const dataForHash = {
      instances: data.instances.map(i => ({
        path: i.path,
        name: i.name,
        branch: i.gitInfo?.branch,
        isDirty: i.gitInfo?.isDirty,
        prNumber: i.prStatus?.number,
        prState: i.prStatus?.state,
        claudeActive: i.claudeStatus?.active,
      })),
    };
    const hash = JSON.stringify(dataForHash);

    // Skip if data hasn't changed
    if (hash === this.lastCacheHash) {
      return false;
    }

    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
    this.lastCacheWrite = now;
    this.lastCacheHash = hash;
    return true;
  }

  /**
   * Force write cache immediately (for shutdown or critical updates)
   */
  private async writeCache() {
    const data = {
      instances: Array.from(this.instances.values()),
      timestamp: Date.now(),
    };
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
    this.lastCacheWrite = Date.now();
  }

  private async getVSCodeInstances(): Promise<VSCodeInstance[]> {
    try {
      const result = await $`/usr/sbin/lsof -c "Code Helper" -a -d cwd -Fn | grep '^n/' | cut -c2- | sort -u`;

      if (!result.stdout.trim()) {
        return [];
      }

      const folderPaths = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((p: string) => p !== '/' && p.length > 1);

      const instances: VSCodeInstance[] = [];

      for (const folderPath of folderPaths) {
        // Skip directories that no longer exist
        try {
          await access(folderPath);
        } catch {
          // Directory doesn't exist, skip it
          continue;
        }

        const name = folderPath.split('/').pop() || folderPath;
        let branch: string | undefined;
        let isGitRepo = false;

        try {
          const branchResult = await $`/usr/bin/git -C ${folderPath} rev-parse --abbrev-ref HEAD`;
          branch = branchResult.stdout.trim();
          isGitRepo = true;
        } catch {
          // Not a git repo
        }

        instances.push({ name, path: folderPath, branch, isGitRepo });
      }

      return instances;
    } catch {
      return [];
    }
  }

  private async enrichInstance(instance: VSCodeInstance, updatePR: boolean = true): Promise<InstanceWithMetadata | null> {
    // Check if directory still exists before doing any work
    try {
      await access(instance.path);
    } catch {
      // Directory doesn't exist - signal to caller to remove this instance
      log(`  ⚠️  Directory no longer exists: ${instance.path}`);
      return null;
    }

    const enriched: InstanceWithMetadata = {
      ...instance,
      lastUpdated: Date.now(),
    };

    // Check for VSCode extension state first (provides instant git branch info)
    const extensionState = await this.getExtensionState(instance.path);
    if (extensionState) {
      enriched.extensionActive = true;
      enriched.extensionVersion = extensionState.extensionVersion;
      enriched.extensionState = extensionState;
    }

    // Get git info (local, fast)
    // If extension provides git info, prefer it for branch name but still fetch full git status
    if (instance.isGitRepo) {
      enriched.gitInfo = await this.getGitInfo(instance.path);

      // If extension provides more recent git info, use its branch
      if (extensionState?.git.branch) {
        if (enriched.gitInfo) {
          enriched.gitInfo.branch = extensionState.git.branch;
        }
      }
    }

    // Get PR status only if requested, not paused, and we have rate limit above critical threshold
    if (updatePR && enriched.gitInfo && !this.rateLimitPaused && this.ghRateLimit && this.ghRateLimit.remaining > RATE_LIMIT_CRITICAL) {
      enriched.prStatus = await this.getPRStatus(instance.path, enriched.gitInfo.branch);
      enriched.prLastUpdated = Date.now(); // Track when PR was last fetched

      // Check for PR state changes and send notifications
      if (enriched.prStatus) {
        const previousState = this.previousPRStates.get(instance.path);
        const currentConclusion = enriched.prStatus.checks?.conclusion;
        const currentMergeable = enriched.prStatus.mergeable;
        const projectName = instance.path.split('/').pop() || 'project';
        const hasChecks = (enriched.prStatus.checks?.total ?? 0) > 0;

        // Detect check failure transition
        if (currentConclusion === 'failure' && previousState?.conclusion !== 'failure') {
          const failedChecks = enriched.prStatus.checks?.runs
            ?.filter(check => check.bucket === 'fail' || check.bucket === 'cancel')
            .map(check => check.name) || [];

          const failCount = enriched.prStatus.checks?.failing || failedChecks.length;
          const checkNames = failedChecks.slice(0, 3).join(', '); // Limit to first 3 names
          const moreText = failedChecks.length > 3 ? `, +${failedChecks.length - 3} more` : '';

          await this.sendNotification(
            'PR Check Failed',
            `❌ ${failCount} check(s) failed in ${projectName}: ${checkNames}${moreText}`,
            'pr_check_failed',
            'failure',
            instance.path
          );
        }

        // Detect check success transition (first time or recovery)
        if (currentConclusion === 'success' && previousState?.conclusion !== 'success' && hasChecks) {
          await this.sendNotification(
            'PR Checks Passing',
            `✅ All checks passed in ${projectName} (PR #${enriched.prStatus.number})`,
            'pr_check_success',
            'success',
            instance.path
          );
        }

        // Detect merge conflict (blocked)
        if (currentMergeable === 'CONFLICTING' && previousState?.mergeable !== 'CONFLICTING') {
          await this.sendNotification(
            'PR Merge Blocked',
            `⚠️ ${projectName} has merge conflicts (PR #${enriched.prStatus.number})`,
            'pr_merge_blocked',
            'failure',
            instance.path
          );
        }

        // Update state tracking
        if (currentConclusion) {
          this.previousPRStates.set(instance.path, {
            conclusion: currentConclusion,
            mergeable: currentMergeable,
          });
        }
      }
    } else {
      // Preserve existing PR status and timestamp if not updating
      const existing = this.instances.get(instance.path);
      if (existing) {
        // Always preserve prLastUpdated to track when we last checked for a PR
        // This prevents unnecessary PR checks even when no PR exists
        enriched.prLastUpdated = existing.prLastUpdated;
        // Also preserve PR status if it exists
        if (existing.prStatus) {
          enriched.prStatus = existing.prStatus;
        }
      }
    }

    // Get existing instance to check for preserved state
    const existingInstance = this.instances.get(instance.path);

    // Claude/OpenCode status is now handled by slow poll (every 2 minutes)
    // Preserve existing status from slow poll or hook-based updates
    if (existingInstance?.claudeStatus) {
      enriched.claudeStatus = existingInstance.claudeStatus;

      // Check for timeout and reset stale working/waiting states
      enriched.claudeStatus = this.checkClaudeTimeout(enriched.claudeStatus);
    }

    // Apply intelligent status based on PR checks
    if (enriched.claudeStatus && enriched.prStatus?.checks?.conclusion === 'pending') {
      // If PR checks are pending, update status based on Claude's current state
      const updatedSessions: Record<number, ClaudeSessionInfo> = {};

      for (const [pid, session] of Object.entries(enriched.claudeStatus.sessions)) {
        if (session.status === 'idle' || session.status === 'finished') {
          // Change idle/finished to checking when PR checks are pending
          updatedSessions[parseInt(pid, 10)] = {
            ...session,
            status: 'checking',
          };
        } else {
          // Keep working/waiting status unchanged
          updatedSessions[parseInt(pid, 10)] = session;
        }
      }

      // Update the primary session status for legacy fields
      const primaryPid = enriched.claudeStatus.primarySession;
      const primarySession = primaryPid ? updatedSessions[primaryPid] : undefined;

      if (primarySession) {
        enriched.claudeStatus = {
          ...enriched.claudeStatus,
          sessions: updatedSessions,
          isWorking: primarySession.status === 'working',
          isWaiting: primarySession.status === 'waiting',
          isChecking: primarySession.status === 'checking',
          claudeFinished: primarySession.status === 'finished',
        };
      }
    }

    // Get tmux status (local, fast)
    enriched.tmuxStatus = await this.getTmuxStatus(instance.path, enriched.gitInfo?.branch);

    // Get Caddy host info (local API call, fast)
    enriched.caddyHost = await this.getCaddyHost(instance.path);

    // Get Spotlight status (health check + stream counts)
    if (enriched.caddyHost && enriched.gitInfo?.branch) {
      enriched.spotlightStatus = await this.getSpotlightStatus(
        instance.path,
        enriched.caddyHost
      );
    }

    return enriched;
  }

  private async getExtensionState(workspacePath: string): Promise<VSCodeExtensionState | null> {
    try {
      const key = `workstream:vscode:state:${Buffer.from(workspacePath).toString('base64')}`;
      const stateStr = await this.redis.get(key);

      if (!stateStr) {
        return null;
      }

      const state = JSON.parse(stateStr) as VSCodeExtensionState;

      // Check if state is fresh (within last 30 seconds)
      const age = Date.now() - state.lastUpdated;
      if (age > 30000) {
        return null;
      }

      return state;
    } catch (error) {
      // Extension state is optional, don't log errors
      return null;
    }
  }

  private async getGitInfo(repoPath: string): Promise<GitInfo | undefined> {
    try {
      // Suppress stderr for upstream check since many branches don't have upstream set
      const [branchResult, statusResult, remoteResult] = await Promise.allSettled([
        $`/usr/bin/git -C ${repoPath} rev-parse --abbrev-ref HEAD`,
        $`/usr/bin/git -C ${repoPath} status --porcelain`,
        $`/usr/bin/git -C ${repoPath} rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo ""`.quiet(),
      ]);

      if (branchResult.status === 'rejected' || statusResult.status === 'rejected') {
        return undefined;
      }

      const branch = branchResult.value.stdout.trim();
      const statusOutput = statusResult.value.stdout;

      let remoteBranch: string | undefined;
      let ahead: number | undefined;
      let behind: number | undefined;

      if (remoteResult.status === 'fulfilled' && remoteResult.value.stdout.trim()) {
        remoteBranch = remoteResult.value.stdout.trim();

        try {
          const countsResult = await $`/usr/bin/git -C ${repoPath} rev-list --left-right --count ${remoteBranch}...HEAD 2>/dev/null || echo ""`.quiet();

          if (countsResult.stdout.trim()) {
            const [behindCount, aheadCount] = countsResult.stdout.trim().split('\t').map(Number);
            ahead = aheadCount;
            behind = behindCount;
          }
        } catch {
          // Ignore
        }
      }

      const statusLines = statusOutput.trim().split('\n').filter(Boolean);
      const modified = statusLines.filter((line: string) => line.startsWith(' M')).length;
      const staged = statusLines.filter((line: string) => line.match(/^[MARC]/)).length;
      const untracked = statusLines.filter((line: string) => line.startsWith('??')).length;
      const isDirty = statusLines.length > 0;

      return {
        branch,
        isGitRepo: true,
        remoteBranch,
        ahead,
        behind,
        isDirty,
        modified,
        staged,
        untracked,
      };
    } catch {
      return undefined;
    }
  }

  private async getPRStatus(repoPath: string, branch: string): Promise<PRStatus | undefined> {
    try {
      const remoteUrlResult = await $`/usr/bin/git -C ${repoPath} remote get-url origin`;

      if (!remoteUrlResult.stdout || !remoteUrlResult.stdout.includes('github.com')) {
        return undefined;
      }

      // Suppress stderr to avoid rate limit error messages
      const prInfoResult = await $`/opt/homebrew/bin/gh pr view ${branch} --repo=${remoteUrlResult.stdout.trim()} --json number,title,url,state,mergeable 2>/dev/null || echo ""`.quiet();

      if (!prInfoResult.stdout.trim()) {
        return undefined;
      }

      const pr = JSON.parse(prInfoResult.stdout);

      let checks: PRStatus['checks'] | undefined;
      if (pr.state === 'OPEN') {
        try {
          const checksInfoResult = await $`/opt/homebrew/bin/gh pr checks ${branch} --repo=${remoteUrlResult.stdout.trim()} --json bucket,name,state 2>/dev/null || echo ""`.quiet();

          if (checksInfoResult.stdout.trim()) {
            const checkResults = JSON.parse(checksInfoResult.stdout);
            const passing = checkResults.filter((c: any) => c.bucket === 'pass').length;
            const failing = checkResults.filter((c: any) => c.bucket === 'fail' || c.bucket === 'cancel').length;
            const pending = checkResults.filter((c: any) => c.bucket === 'pending').length;
            const total = checkResults.length;

            checks = {
              passing,
              failing,
              pending,
              total,
              conclusion: pending > 0 ? 'pending' : failing > 0 ? 'failure' : 'success',
              runs: checkResults.map((c: any) => ({
                name: c.name,
                state: c.state,
                bucket: c.bucket,
              })),
            };
          }
        } catch {
          // No checks
        }
      }

      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        mergeable: pr.mergeable,
        checks,
      };
    } catch {
      return undefined;
    }
  }

  private async getClaudeStatus(repoPath: string): Promise<ClaudeStatus | undefined> {
    try {
      // Use pgrep instead of ps aux | grep for better performance
      const pgrepResult = await $`/usr/bin/pgrep -f "claude" 2>/dev/null || true`;
      const pids = pgrepResult.stdout.trim().split('\n').filter(Boolean);

      // Get existing status if available to preserve hook-based state
      const existing = this.instances.get(repoPath);
      const sessions: Record<number, ClaudeSessionInfo> = { ...(existing?.claudeStatus?.sessions || {}) };

      // Track which PIDs we find running
      const runningPids = new Set<number>();

      // Find all Claude processes for this repo
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        const lsofResult = await $`/usr/sbin/lsof -p ${pidStr} 2>/dev/null || true`;

        const cwdLine = lsofResult.stdout.split('\n').find((line: string) => line.includes(' cwd '));
        if (cwdLine) {
          const parts = cwdLine.trim().split(/\s+/);
          const cwd = parts[parts.length - 1];

          if (cwd === repoPath) {
            runningPids.add(pid);

            // Get existing session info for this PID
            const existingSession = sessions[pid];

            // If we have hook-based state for this session, preserve it
            // Otherwise, mark it as idle (process exists but no recent hook activity)
            if (existingSession) {
              // Keep existing session info
              sessions[pid] = {
                ...existingSession,
                lastActivity: existingSession.lastActivity || Date.now(),
              };
            } else {
              // New session discovered via process scan
              sessions[pid] = {
                pid,
                status: 'idle',
                lastActivity: Date.now(),
              };
            }
          }
        }
      }

      // Mark sessions as finished if their process is no longer running
      for (const [pidStr, session] of Object.entries(sessions)) {
        const pid = parseInt(pidStr, 10);
        if (!runningPids.has(pid) && session.status !== 'finished') {
          sessions[pid] = {
            ...session,
            status: 'finished',
            finishedAt: Date.now(),
          };
        }
      }

      // If we have any sessions, return status
      if (Object.keys(sessions).length > 0) {
        // Determine primary session (most recently active)
        let primaryPid = existing?.claudeStatus?.primarySession;
        let mostRecentActivity = 0;

        for (const [pidStr, session] of Object.entries(sessions)) {
          if (session.status !== 'finished' && session.lastActivity > mostRecentActivity) {
            primaryPid = parseInt(pidStr, 10);
            mostRecentActivity = session.lastActivity;
          }
        }

        // If no active session, use the first session
        if (!primaryPid || !sessions[primaryPid]) {
          primaryPid = parseInt(Object.keys(sessions)[0], 10);
        }

        const primarySession = sessions[primaryPid];

        // Build legacy fields from primary session
        return {
          sessions,
          primarySession: primaryPid,
          active: primarySession.status !== 'finished',
          pid: primaryPid,
          isWorking: primarySession.status === 'working',
          isWaiting: primarySession.status === 'waiting',
          isChecking: primarySession.status === 'checking',
          claudeFinished: primarySession.status === 'finished',
          lastEventTime: primarySession.lastActivity,
          workStartedAt: primarySession.workStartedAt,
          finishedAt: primarySession.finishedAt,
          terminalId: primarySession.terminalId,
          terminalPid: primarySession.terminalPid,
          vscodePid: primarySession.vscodePid,
        };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Check if Claude status has timed out and reset if necessary.
   * This prevents the "Working" state from getting stuck when a task is interrupted.
   * Also cleans up old finished sessions.
   */
  private checkClaudeTimeout(claudeStatus: ClaudeStatus): ClaudeStatus {
    const now = Date.now();
    const sessions = { ...claudeStatus.sessions };
    const FINISHED_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 minutes - remove finished sessions
    let hasChanges = false;

    // Check each session for timeouts and cleanup
    for (const [pidStr, session] of Object.entries(sessions)) {
      const pid = parseInt(pidStr, 10);

      // Remove finished sessions older than 10 minutes
      if (session.status === 'finished' && session.finishedAt) {
        const elapsed = now - session.finishedAt;
        if (elapsed > FINISHED_CLEANUP_TIMEOUT) {
          delete sessions[pid];
          hasChanges = true;
          continue;
        }
      }

      // Check if working state has timed out
      if (session.status === 'working' && session.workStartedAt) {
        const elapsed = now - session.workStartedAt;
        if (elapsed > CLAUDE_WORK_TIMEOUT) {
          log(`⏱️  Claude work timeout detected for PID ${pid} (${Math.round(elapsed / 1000)}s), resetting to idle`);
          sessions[pid] = {
            ...session,
            status: 'idle',
          };
          hasChanges = true;
        }
      }

      // Check if waiting state has timed out
      if (session.status === 'waiting' && session.lastActivity) {
        const elapsed = now - session.lastActivity;
        if (elapsed > CLAUDE_WAIT_TIMEOUT) {
          log(`⏱️  Claude wait timeout detected for PID ${pid} (${Math.round(elapsed / 1000)}s), resetting to idle`);
          sessions[pid] = {
            ...session,
            status: 'idle',
          };
          hasChanges = true;
        }
      }
    }

    // If we made changes, rebuild the status
    if (hasChanges) {
      // Determine new primary session if needed
      let primaryPid = claudeStatus.primarySession;
      if (!primaryPid || !sessions[primaryPid]) {
        // Find most recently active non-finished session
        let mostRecentActivity = 0;
        for (const [pidStr, session] of Object.entries(sessions)) {
          if (session.status !== 'finished' && session.lastActivity > mostRecentActivity) {
            primaryPid = parseInt(pidStr, 10);
            mostRecentActivity = session.lastActivity;
          }
        }
      }

      // If we have a primary session, update legacy fields
      if (primaryPid && sessions[primaryPid]) {
        const primarySession = sessions[primaryPid];
        return {
          ...claudeStatus,
          sessions,
          primarySession: primaryPid,
          active: primarySession.status !== 'finished',
          isWorking: primarySession.status === 'working',
          isWaiting: primarySession.status === 'waiting',
          claudeFinished: primarySession.status === 'finished',
          lastEventTime: primarySession.lastActivity,
          workStartedAt: primarySession.workStartedAt,
          finishedAt: primarySession.finishedAt,
        };
      }

      // No sessions left
      return {
        ...claudeStatus,
        sessions,
      };
    }

    return claudeStatus;
  }

  private async getTmuxStatus(repoPath: string, branch?: string): Promise<TmuxStatus | undefined> {
    try {
      // Get folder name
      const folderName = repoPath.split('/').pop() || 'unknown';

      // Create session name using tmuxdev logic: {folderName}-{branchName}
      const sessionName = branch ? `${folderName}-${branch}` : folderName;

      // Check if session exists
      let exists = false;
      try {
        await $`tmux has-session -t ${sessionName} 2>/dev/null`.quiet();
        exists = true;
      } catch {
        exists = false;
      }

      return {
        name: sessionName,
        exists,
      };
    } catch {
      return undefined;
    }
  }

  private async getCaddyHost(repoPath: string): Promise<CaddyHost | undefined> {
    try {
      // Fetch Caddy config from API
      const response = await fetch('http://localhost:2019/config/');
      if (!response.ok) {
        return undefined;
      }

      const config: any = await response.json();

      // Extract hosts and find matching worktree path
      const normalizedPath = repoPath.replace(/\/$/, ''); // Remove trailing slash

      if (config.apps?.http?.servers) {
        for (const [serverName, server] of Object.entries<any>(config.apps.http.servers)) {
          if (server.routes) {
            for (const route of server.routes) {
              if (route.match) {
                for (const match of route.match) {
                  if (match.host) {
                    for (const hostName of match.host) {
                      // Extract upstreams and worktree path
                      const upstreams: Set<string> = new Set();
                      let worktreePath: string | undefined;

                      const extractData = (handlers: any[]) => {
                        if (!handlers) return;

                        for (const handler of handlers) {
                          if (handler.handler === 'reverse_proxy') {
                            if (Array.isArray(handler.upstreams)) {
                              for (const upstream of handler.upstreams) {
                                if (upstream.dial) {
                                  upstreams.add(upstream.dial);
                                }
                              }
                            }

                            // Extract worktree path from headers
                            if (handler.headers?.response?.set?.['X-Worktree-Path']?.[0]) {
                              worktreePath = handler.headers.response.set['X-Worktree-Path'][0];
                            }
                          } else if (handler.handler === 'subroute' && Array.isArray(handler.routes)) {
                            for (const subroute of handler.routes) {
                              if (subroute.handle) {
                                extractData(subroute.handle);
                              }
                            }
                          }
                        }
                      };

                      if (route.handle) {
                        extractData(route.handle);
                      }

                      // Check if this host matches the worktree path
                      if (worktreePath && worktreePath.replace(/\/$/, '') === normalizedPath) {
                        const protocol = serverName.includes('https') || serverName === 'srv1' ? 'https' : 'http';
                        return {
                          name: hostName,
                          url: `${protocol}://${hostName}`,
                          upstreams: upstreams.size > 0 ? Array.from(upstreams) : undefined,
                          worktreePath,
                          routes: route.handle,
                          isActive: true,
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      return undefined;
    } catch (error) {
      // Caddy might not be running, silently return undefined
      return undefined;
    }
  }

  private async getSpotlightStatus(
    instancePath: string,
    caddyHost: CaddyHost
  ): Promise<SpotlightStatus | undefined> {
    try {
      // Extract spotlight port from Caddy routes (same logic as Raycast)
      const routes = (caddyHost.routes || []) as any[];

      const findSpotlightPort = (routeList: any[]): number | null => {
        for (const route of routeList) {
          // If this is a subroute, search its nested routes
          if (route.handler === 'subroute' && route.routes) {
            const result = findSpotlightPort(route.routes);
            if (result) return result;
          }

          // Check if this route matches /_spotlight
          if (route.match?.[0]?.path?.some((p: string) => p.includes('/_spotlight'))) {
            // Look through handlers to find reverse_proxy with upstreams
            for (const handler of route.handle || []) {
              if (handler.handler === 'reverse_proxy' && handler.upstreams?.[0]?.dial) {
                const upstream = handler.upstreams[0].dial;
                if (typeof upstream === 'string') {
                  const parts = upstream.split(':');
                  if (parts.length === 2) {
                    return parseInt(parts[1], 10);
                  }
                }
              }
            }
          }
        }
        return null;
      };

      const port = findSpotlightPort(routes);
      if (!port) {
        return undefined;
      }

      const instanceName = instancePath.split('/').pop() || instancePath;
      log(`[Spotlight] Found spotlight port ${port} for ${instanceName}`);

      // Check if spotlight is online
      const isOnline = await spotlightMonitor.checkHealth(port);
      log(`[Spotlight] Health check for ${instanceName} (port ${port}): ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

      // Get or initialize counts
      let counts = spotlightMonitor.getCounts(instancePath);

      if (isOnline) {
        // If online and not connected, start the stream connection
        const isConnected = spotlightMonitor.isConnected(instancePath);
        log(`[Spotlight] ${instanceName} connection status: ${isConnected ? 'already connected' : 'not connected'}`);

        if (!isConnected) {
          log(`[Spotlight] Starting stream connection for ${instanceName} on port ${port}`);
          spotlightMonitor.connectStream(port, instancePath);
          // Initialize counts if not present
          if (!counts) {
            counts = {
              errors: 0,
              traces: 0,
              logs: 0,
              lastUpdated: Date.now(),
            };
          }
        } else {
          log(`[Spotlight] ${instanceName} already has active stream connection`);
        }
      } else {
        // If offline, disconnect any existing stream
        if (spotlightMonitor.isConnected(instancePath)) {
          log(`[Spotlight] Disconnecting stream for ${instanceName} (offline)`);
          spotlightMonitor.disconnectStream(instancePath);
        }
      }

      const status = {
        port,
        isOnline,
        errorCount: counts?.errors || 0,
        traceCount: counts?.traces || 0,
        logCount: counts?.logs || 0,
        lastChecked: Date.now(),
      };

      if (counts && (counts.errors > 0 || counts.traces > 0 || counts.logs > 0)) {
        log(`[Spotlight] ${instanceName} counts: E:${counts.errors} T:${counts.traces} L:${counts.logs}`);
      }

      return status;
    } catch (error) {
      logError('[Spotlight] Error getting spotlight status:', error);
      return undefined;
    }
  }

  /**
   * Fetch terminal context from Redis for a given Claude PID.
   * Terminal context is stored by the TerminalTracker when Claude is detected in a terminal.
   */
  private async getTerminalContextForClaude(claudePid: number): Promise<{
    terminalId?: string;
    terminalPid?: number;
    terminalName?: string;
    vscodePid?: number;
    workspace?: string;
  } | null> {
    try {
      const key = `claude:terminal:${claudePid}`;
      const data = await this.redis.get(key);
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      logError(`Failed to fetch terminal context for Claude PID ${claudePid}:`, error);
      return null;
    }
  }

  private async handleClaudeStarted(repoPath: string, claudePid?: number, terminalName?: string, terminalId?: string, terminalPid?: number, vscodePid?: number) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        const now = Date.now();

        // If claudePid is provided, update the specific session
        if (claudePid) {
          // Fetch terminal context from Redis if not provided in the event
          let terminalContext = null;
          if (!terminalId && !terminalPid && !vscodePid) {
            log(`🔍 Fetching terminal context for Claude PID ${claudePid}...`);
            terminalContext = await this.getTerminalContextForClaude(claudePid);
            if (terminalContext) {
              log(`✅ Found terminal context: ${JSON.stringify(terminalContext)}`);
            } else {
              log(`❌ No terminal context found for Claude PID ${claudePid}`);
            }
          }

          // Initialize sessions map if needed
          if (!instance.claudeStatus.sessions) {
            instance.claudeStatus.sessions = {};
          }

          // Get existing session or create new one
          const existingSession = instance.claudeStatus.sessions[claudePid];
          const wasWaiting = existingSession?.status === 'waiting';

          // Update or create session, merging terminal context from Redis if available
          instance.claudeStatus.sessions[claudePid] = {
            pid: claudePid,
            status: 'working',
            terminalName: terminalName || terminalContext?.terminalName || existingSession?.terminalName,
            terminalId: terminalId || terminalContext?.terminalId || existingSession?.terminalId,
            terminalPid: terminalPid ?? terminalContext?.terminalPid ?? existingSession?.terminalPid,
            vscodePid: vscodePid ?? terminalContext?.vscodePid ?? existingSession?.vscodePid,
            lastActivity: now,
            workStartedAt: existingSession?.workStartedAt || now,
          };

          // Set as primary session
          instance.claudeStatus.primarySession = claudePid;

          // Update legacy fields for backwards compatibility
          instance.claudeStatus.pid = claudePid;
          instance.claudeStatus.active = true;
          instance.claudeStatus.isWorking = true;
          instance.claudeStatus.isWaiting = false;
          instance.claudeStatus.isCompacting = false;
          instance.claudeStatus.workStartedAt = instance.claudeStatus.sessions[claudePid].workStartedAt;
          instance.claudeStatus.lastEventTime = now;
          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
          log(`Claude started working in ${projectName}`);
        } else {
          // Fallback to legacy behavior if no PID provided
          const wasWaiting = instance.claudeStatus.isWaiting;
          instance.claudeStatus.isWorking = true;
          instance.claudeStatus.isWaiting = false;
          instance.claudeStatus.isCompacting = false;
          instance.claudeStatus.workStartedAt = now;
          instance.claudeStatus.lastEventTime = now;

          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
        }
      }
    } catch (error) {
      logError('Error handling Claude started:', error);
    }
  }

  private async handleClaudeCompacting(repoPath: string, claudePid?: number, terminalName?: string, terminalId?: string, terminalPid?: number, vscodePid?: number) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        const now = Date.now();

        // If claudePid is provided, update the specific session
        if (claudePid) {
          // Fetch terminal context from Redis if not provided in the event
          let terminalContext = null;
          if (!terminalId && !terminalPid && !vscodePid) {
            log(`🔍 Fetching terminal context for Claude PID ${claudePid}...`);
            terminalContext = await this.getTerminalContextForClaude(claudePid);
            if (terminalContext) {
              log(`✅ Found terminal context: ${JSON.stringify(terminalContext)}`);
            } else {
              log(`❌ No terminal context found for Claude PID ${claudePid}`);
            }
          }

          // Initialize sessions map if needed
          if (!instance.claudeStatus.sessions) {
            instance.claudeStatus.sessions = {};
          }

          // Get existing session or create new one
          const existingSession = instance.claudeStatus.sessions[claudePid];

          // Update or create session, merging terminal context from Redis if available
          instance.claudeStatus.sessions[claudePid] = {
            pid: claudePid,
            status: 'compacting',
            terminalName: terminalName || terminalContext?.terminalName || existingSession?.terminalName,
            terminalId: terminalId || terminalContext?.terminalId || existingSession?.terminalId,
            terminalPid: terminalPid ?? terminalContext?.terminalPid ?? existingSession?.terminalPid,
            vscodePid: vscodePid ?? terminalContext?.vscodePid ?? existingSession?.vscodePid,
            lastActivity: now,
            workStartedAt: existingSession?.workStartedAt || now,
          };

          // Set as primary session
          instance.claudeStatus.primarySession = claudePid;

          // Update legacy fields for backwards compatibility
          instance.claudeStatus.pid = claudePid;
          instance.claudeStatus.active = true;
          instance.claudeStatus.isWorking = false;
          instance.claudeStatus.isWaiting = false;
          instance.claudeStatus.isCompacting = true;
          instance.claudeStatus.lastEventTime = now;
          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
          log(`Claude compacting context in ${projectName}`);
        } else {
          // Fallback to legacy behavior if no PID provided
          instance.claudeStatus.isWorking = false;
          instance.claudeStatus.isWaiting = false;
          instance.claudeStatus.isCompacting = true;
          instance.claudeStatus.lastEventTime = now;

          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
        }
      }
    } catch (error) {
      logError('Error handling Claude compacting:', error);
    }
  }

  private async handleClaudeWaiting(repoPath: string, claudePid?: number, terminalName?: string, terminalId?: string, terminalPid?: number, vscodePid?: number) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        const now = Date.now();

        // If claudePid is provided, update the specific session
        if (claudePid) {
          // Fetch terminal context from Redis if not provided in the event
          let terminalContext = null;
          if (!terminalId && !terminalPid && !vscodePid) {
            log(`🔍 Fetching terminal context for Claude PID ${claudePid}...`);
            terminalContext = await this.getTerminalContextForClaude(claudePid);
            if (terminalContext) {
              log(`✅ Found terminal context: ${JSON.stringify(terminalContext)}`);
            } else {
              log(`❌ No terminal context found for Claude PID ${claudePid}`);
            }
          }

          // Initialize sessions map if needed
          if (!instance.claudeStatus.sessions) {
            instance.claudeStatus.sessions = {};
          }

          // Get existing session or create new one
          const existingSession = instance.claudeStatus.sessions[claudePid];

          // Update or create session, merging terminal context from Redis if available
          instance.claudeStatus.sessions[claudePid] = {
            pid: claudePid,
            status: 'waiting',
            terminalName: terminalName || terminalContext?.terminalName || existingSession?.terminalName,
            terminalId: terminalId || terminalContext?.terminalId || existingSession?.terminalId,
            terminalPid: terminalPid ?? terminalContext?.terminalPid ?? existingSession?.terminalPid,
            vscodePid: vscodePid ?? terminalContext?.vscodePid ?? existingSession?.vscodePid,
            lastActivity: now,
            workStartedAt: existingSession?.workStartedAt,
          };

          // Set as primary session
          instance.claudeStatus.primarySession = claudePid;

          // Update legacy fields for backwards compatibility
          instance.claudeStatus.pid = claudePid;
          instance.claudeStatus.active = true;
          instance.claudeStatus.isWaiting = true;
          instance.claudeStatus.isWorking = false;
          instance.claudeStatus.isCompacting = false;
          instance.claudeStatus.lastEventTime = now;
          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          // Send notification
          const projectName = repoPath.split('/').pop() || 'project';
          await this.sendNotification(
            'Claude Code',
            `🤔 Claude needs your attention in ${projectName}`,
            'claude_waiting',
            'failure',
            repoPath
          );

          log(`Claude waiting for input in ${projectName}`);
        } else {
          // Fallback to legacy behavior if no PID provided
          instance.claudeStatus.isWaiting = true;
          instance.claudeStatus.isWorking = false;
          instance.claudeStatus.isCompacting = false;
          instance.claudeStatus.lastEventTime = now;

          if (terminalId) instance.claudeStatus.terminalId = terminalId;
          if (terminalPid !== undefined) instance.claudeStatus.terminalPid = terminalPid;
          if (vscodePid !== undefined) instance.claudeStatus.vscodePid = vscodePid;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
          await this.sendNotification(
            'Claude Code',
            `🤔 Claude needs your attention in ${projectName}`,
            'claude_waiting',
            'failure',
            repoPath
          );
        }
      }
    } catch (error) {
      logError('Error handling Claude waiting:', error);
    }
  }

  private async handleClaudeFinished(repoPath: string, claudePid?: number, terminalName?: string, terminalId?: string, terminalPid?: number, vscodePid?: number) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        const now = Date.now();

        // If claudePid is provided, update the specific session
        if (claudePid) {
          // Fetch terminal context from Redis if not provided in the event
          let terminalContext = null;
          if (!terminalId && !terminalPid && !vscodePid) {
            log(`🔍 Fetching terminal context for Claude PID ${claudePid}...`);
            terminalContext = await this.getTerminalContextForClaude(claudePid);
            if (terminalContext) {
              log(`✅ Found terminal context: ${JSON.stringify(terminalContext)}`);
            } else {
              log(`❌ No terminal context found for Claude PID ${claudePid}`);
            }
          }

          // Initialize sessions map if needed
          if (!instance.claudeStatus.sessions) {
            instance.claudeStatus.sessions = {};
          }

          // Get existing session or create new one
          const existingSession = instance.claudeStatus.sessions[claudePid];

          // Mark session as finished, merging terminal context from Redis if available
          instance.claudeStatus.sessions[claudePid] = {
            pid: claudePid,
            status: 'finished',
            terminalName: terminalName || terminalContext?.terminalName || existingSession?.terminalName,
            terminalId: terminalId || terminalContext?.terminalId || existingSession?.terminalId,
            terminalPid: terminalPid ?? terminalContext?.terminalPid ?? existingSession?.terminalPid,
            vscodePid: vscodePid ?? terminalContext?.vscodePid ?? existingSession?.vscodePid,
            lastActivity: now,
            workStartedAt: existingSession?.workStartedAt,
            finishedAt: now,
          };

          // Update legacy fields for backwards compatibility (based on primary session)
          const primaryPid = instance.claudeStatus.primarySession || claudePid;
          const primarySession = instance.claudeStatus.sessions[primaryPid];
          if (primarySession) {
            instance.claudeStatus.pid = primaryPid;
            instance.claudeStatus.active = primarySession.status !== 'finished';
            instance.claudeStatus.isWorking = primarySession.status === 'working';
            instance.claudeStatus.isWaiting = primarySession.status === 'waiting';
            instance.claudeStatus.isCompacting = primarySession.status === 'compacting';
            instance.claudeStatus.claudeFinished = primarySession.status === 'finished';
            instance.claudeStatus.finishedAt = primarySession.finishedAt;
            instance.claudeStatus.workStartedAt = primarySession.workStartedAt;
            instance.claudeStatus.lastEventTime = primarySession.lastActivity;
          }

          await this.writeCache();
          await this.publishUpdate();

          // Send notification
          const projectName = repoPath.split('/').pop() || 'project';
          await this.sendNotification(
            'Claude Code',
            `✅ Claude finished working in ${projectName}`,
            'claude_finished',
            'success',
            repoPath
          );

          log(`Claude finished in ${projectName}`);
        } else {
          // Fallback to legacy behavior if no PID provided
          instance.claudeStatus.isWaiting = false;
          instance.claudeStatus.isWorking = false;
          instance.claudeStatus.isCompacting = false;
          instance.claudeStatus.claudeFinished = true;
          instance.claudeStatus.finishedAt = now;
          instance.claudeStatus.workStartedAt = undefined;
          instance.claudeStatus.lastEventTime = undefined;

          await this.writeCache();
          await this.publishUpdate();

          const projectName = repoPath.split('/').pop() || 'project';
          await this.sendNotification(
            'Claude Code',
            `✅ Claude finished working in ${projectName}`,
            'claude_finished',
            'success',
            repoPath
          );
        }
      }
    } catch (error) {
      logError('Error handling Claude finished:', error);
    }
  }

  private async handleClearFinished(repoPath: string) {
    try {
      // Clear the finished flag when user switches to instance
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        instance.claudeStatus.claudeFinished = false;
        await this.writeCache();
        await this.publishUpdate();

        const projectName = repoPath.split('/').pop() || 'project';
        log(`Cleared finished flag for ${projectName}`);
      }
    } catch (error) {
      logError('Error clearing finished flag:', error);
    }
  }

  private async handleVSCodeHeartbeat(workspacePath: string) {
    try {
      // Get the instance
      const instance = this.instances.get(workspacePath);
      if (!instance) {
        return; // Instance not tracked, ignore
      }

      // Fetch fresh extension state from Redis
      const extensionState = await this.getExtensionState(workspacePath);

      if (extensionState) {
        // Update instance with fresh state
        instance.extensionActive = true;
        instance.extensionVersion = extensionState.extensionVersion;
        instance.extensionState = extensionState;
        instance.lastUpdated = Date.now();

        // Update git branch if extension provides it
        if (extensionState.git.branch && instance.gitInfo) {
          instance.gitInfo.branch = extensionState.git.branch;
        }

        // Write to cache and publish update immediately
        await this.writeCache();
        await this.publishUpdate();
      }
    } catch (error) {
      logError('Error handling VSCode heartbeat:', error);
    }
  }

  private async handleWorktreeJob(data: {
    jobId: string;
    worktreeName: string;
    repoPath: string;
    baseBranch?: string;
    force?: boolean;
    createOwnUpstream?: boolean;
    timestamp: number;
  }) {
    const { jobId, worktreeName, repoPath, baseBranch, force, createOwnUpstream } = data;
    let outputBuffer = '';
    const lockKey = REDIS_KEYS.WORKTREE_LOCK(repoPath, worktreeName);
    let lockAcquired = false;

    try {
      // Try to acquire a distributed lock to prevent race conditions
      // Lock expires after 5 minutes (300 seconds) as a safety measure
      const lockResult = await this.redis.set(lockKey, jobId, 'EX', 300, 'NX');
      
      if (!lockResult) {
        // Another job is already processing this worktree
        const existingJobId = await this.redis.get(lockKey);
        log(`  ⚠️ Worktree creation already in progress for ${worktreeName} (held by job: ${existingJobId})`);
        
        // Mark this job as skipped/duplicate
        await this.redis.set(
          REDIS_KEYS.WORKTREE_JOB(jobId),
          JSON.stringify({
            ...data,
            status: 'skipped',
            output: `Worktree creation already in progress for ${worktreeName}. Another job (${existingJobId}) is handling this request.\n`,
            error: 'duplicate_job',
            startedAt: data.timestamp,
            completedAt: Date.now(),
          }),
          'EX',
          3600
        );

        // Publish skipped status
        await this.publisher.publish(
          REDIS_CHANNELS.WORKTREE_UPDATES,
          JSON.stringify({
            jobId,
            status: 'skipped',
            output: `Worktree creation already in progress for ${worktreeName}`,
            error: 'duplicate_job',
            repoPath,
            worktreeName,
            timestamp: Date.now(),
          })
        );
        return;
      }
      
      lockAcquired = true;
      log(`  🔒 Acquired lock for worktree: ${worktreeName}`);

      // Store initial job status in Redis
      await this.redis.set(
        REDIS_KEYS.WORKTREE_JOB(jobId),
        JSON.stringify({
          ...data,
          status: 'running',
          output: 'Starting worktree creation...\n',
          startedAt: Date.now(),
        }),
        'EX',
        3600 // Expire after 1 hour
      );

      // Publish initial status update
      await this.publisher.publish(
        REDIS_CHANNELS.WORKTREE_UPDATES,
        JSON.stringify({
          jobId,
          status: 'running',
          output: 'Starting worktree creation...\n',
          repoPath,
          worktreeName,
          timestamp: Date.now(),
        })
      );

      // Create worktree with streaming output
      const result = await createWorktree({
        branchName: worktreeName,
        repoPath,
        baseBranch,
        force: force || false,
        createOwnUpstream,
        onOutput: (message, type) => {
          const formattedMessage = `${message}\n`;
          outputBuffer += formattedMessage;

          // Publish streaming update
          this.publisher.publish(
            REDIS_CHANNELS.WORKTREE_UPDATES,
            JSON.stringify({
              jobId,
              status: 'running',
              output: formattedMessage,
              repoPath,
              worktreeName,
              timestamp: Date.now(),
            })
          ).catch((err) => logError('Error publishing worktree update:', err));

          // Also update the job in Redis
          this.redis.get(REDIS_KEYS.WORKTREE_JOB(jobId)).then((jobData) => {
            if (jobData) {
              const job = JSON.parse(jobData);
              job.output = outputBuffer;
              this.redis.set(
                REDIS_KEYS.WORKTREE_JOB(jobId),
                JSON.stringify(job),
                'EX',
                3600
              ).catch((err) => logError('Error updating job in Redis:', err));
            }
          }).catch((err) => logError('Error getting job from Redis:', err));
        },
      });

      if (result.success) {
        // Open VS Code
        outputBuffer += 'Opening VS Code...\n';
        try {
          await $`code "${result.worktreePath}"`;
          outputBuffer += 'VS Code opened successfully!\n';
        } catch (err) {
          outputBuffer += `Warning: Could not open VS Code: ${err}\n`;
        }

        // Store final success status
        await this.redis.set(
          REDIS_KEYS.WORKTREE_JOB(jobId),
          JSON.stringify({
            ...data,
            status: 'completed',
            output: outputBuffer,
            worktreePath: result.worktreePath,
            startedAt: data.timestamp,
            completedAt: Date.now(),
          }),
          'EX',
          3600
        );

        // Publish completion
        await this.publisher.publish(
          REDIS_CHANNELS.WORKTREE_UPDATES,
          JSON.stringify({
            jobId,
            status: 'completed',
            output: outputBuffer,
            worktreePath: result.worktreePath,
            repoPath,
            worktreeName,
            timestamp: Date.now(),
          })
        );

        log(`  ✅ Worktree created successfully: ${result.worktreePath}`);
      } else {
        throw new Error(result.error || 'Worktree creation failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      outputBuffer += `Error: ${errorMessage}\n`;

      // Store failure status
      await this.redis.set(
        REDIS_KEYS.WORKTREE_JOB(jobId),
        JSON.stringify({
          ...data,
          status: 'failed',
          output: outputBuffer,
          error: errorMessage,
          startedAt: data.timestamp,
          completedAt: Date.now(),
        }),
        'EX',
        3600
      );

      // Publish failure
      await this.publisher.publish(
        REDIS_CHANNELS.WORKTREE_UPDATES,
        JSON.stringify({
          jobId,
          status: 'failed',
          output: outputBuffer,
          error: errorMessage,
          repoPath,
          worktreeName,
          timestamp: Date.now(),
        })
      );

      logError(`  ❌ Worktree creation failed:`, error);
    } finally {
      // Always release the lock if we acquired it
      if (lockAcquired) {
        try {
          await this.redis.del(lockKey);
          log(`  🔓 Released lock for worktree: ${worktreeName}`);
        } catch (unlockError) {
          logError(`  ⚠️ Failed to release lock for ${worktreeName}:`, unlockError);
        }
      }
    }
  }

  private async sendNotification(
    title: string,
    message: string,
    type: 'claude_started' | 'claude_waiting' | 'claude_finished' | 'pr_check_failed' | 'pr_check_success' | 'pr_merge_blocked' | 'notification' = 'notification',
    style: 'success' | 'failure' | 'info' = 'info',
    projectPath?: string
  ) {
    try {
      // 1. Publish to Redis for Raycast Toast notifications
      await this.publisher.publish(
        REDIS_CHANNELS.NOTIFICATIONS,
        JSON.stringify({
          type,
          title,
          message,
          style,
          timestamp: Date.now(),
          projectPath,
          projectName: projectPath?.split('/').pop() || 'unknown',
        })
      );

      // 2. Send macOS system notification
      await this.sendSystemNotification(title, message);
    } catch (error) {
      // Don't crash if notification fails
      logError('Failed to send notification:', error);
    }
  }

  /**
   * Send a macOS system notification (without publishing to Redis)
   */
  private async sendSystemNotification(title: string, message: string) {
    try {
      // Try terminal-notifier first (already approved in permissions)
      await $`/opt/homebrew/bin/terminal-notifier -title ${title} -message ${message}`.quiet();
    } catch {
      // Fallback to osascript (built-in macOS)
      try {
        await $`/usr/bin/osascript -e 'display notification "${message}" with title "${title}"'`.quiet();
      } catch (error) {
        // Silent fail - notifications are nice-to-have
      }
    }
  }

  private async getChromeWindows(): Promise<ChromeWindow[]> {
    try {
      // Check if Chrome is running
      const chromeCheck = await $`/usr/bin/pgrep -x "Google Chrome"`.quiet();
      if (!chromeCheck.stdout.trim()) {
        return [];
      }

      // Use AppleScript to query Chrome windows and tabs
      const script = `
        tell application "Google Chrome"
          set _output to ""
          repeat with w in windows
            set _w_id to get id of w
            set _tab_index to 0
            repeat with t in tabs of w
              set _title to get title of t
              set _url to get URL of t
              set _output to (_output & _w_id & "~~~" & _tab_index & "~~~" & _title & "~~~" & _url & "\\n")
              set _tab_index to _tab_index + 1
            end repeat
          end repeat
          return _output
        end tell
      `;

      const result = await $`/usr/bin/osascript -e ${script}`.quiet();

      if (!result.stdout.trim()) {
        return [];
      }

      // Parse the output
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const windowsMap = new Map<number, ChromeWindow>();

      for (const line of lines) {
        const [windowIdStr, indexStr, title, url] = line.split('~~~');
        const windowId = parseInt(windowIdStr, 10);
        const index = parseInt(indexStr, 10);

        if (!windowsMap.has(windowId)) {
          windowsMap.set(windowId, {
            id: windowId,
            tabs: [],
            lastUpdated: Date.now(),
          });
        }

        const window = windowsMap.get(windowId)!;
        window.tabs.push({
          index,
          title: title || 'Untitled',
          url: url || '',
        });
      }

      return Array.from(windowsMap.values());
    } catch (error) {
      // Chrome not installed or not running, return empty array
      return [];
    }
  }
}

// Handle graceful shutdown
const daemon = new WorkstreamDaemon();

process.on('SIGINT', async () => {
  log('\nReceived SIGINT, shutting down...');
  await daemon.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('\nReceived SIGTERM, shutting down...');
  await daemon.stop();
  process.exit(0);
});

// Start daemon
daemon.start().catch((error) => {
  logError('Failed to start daemon:', error);
  process.exit(1);
});
