import { $ } from 'zx';
import Redis from 'ioredis';
import { getRedisClient, getPublisherClient, REDIS_KEYS, REDIS_CHANNELS } from './redis-client.js';

// Disable verbose output from zx
$.verbose = false;

interface PRCheck {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping';
}

interface CiChecksInfo {
  passing: number;
  failing: number;
  pending: number;
  conclusion: 'success' | 'failure' | 'pending';
  runs: PRCheck[];
}

interface PullRequestInfo {
  number: number;
  url: string;
  status: 'open' | 'merged' | 'closed' | 'unknown';
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  ci_status?: 'pending' | 'passing' | 'failing' | null;
  ci_checks?: CiChecksInfo | null;
  ci_last_updated_at?: string | null;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
}

interface KanbanTaskInstance {
  sourceType: string;
  taskId: string;
  title: string;
  status: string;
  projectName: string;
  branch?: string;
  prInfo?: PullRequestInfo;
  repoPath?: string;
  updatedAt: string;
  prStatus?: {
    number: number;
    state: string;
    mergeable?: string;
    checks?: CiChecksInfo;
  };
}

interface UpdateNotification {
  eventType: string;
  taskId: string;
  timestamp: string;
}

/**
 * Integration with Vibe Kanban to enrich tasks with CI status
 */
export class VibeKanbanIntegration {
  private redis: Redis;
  private publisher: Redis;
  private subscriber: Redis | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private knownTasks: Map<string, KanbanTaskInstance> = new Map();
  private isRunning = false;

  // Rate limiting for gh CLI
  private ghRateLimit: { remaining: number; reset: Date } | null = null;
  private readonly POLL_INTERVAL_MS = 60000; // 1 minute

  constructor() {
    this.redis = getRedisClient();
    this.publisher = getPublisherClient();
  }

  /**
   * Start the integration
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[VibeKanban] Already running');
      return;
    }

    console.log('[VibeKanban] Starting integration...');
    this.isRunning = true;

    // Create a dedicated subscriber connection
    this.subscriber = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
    });

    // Subscribe to updates channel
    await this.subscriber.subscribe(REDIS_CHANNELS.UPDATES);
    this.subscriber.on('message', (channel, message) => {
      if (channel === REDIS_CHANNELS.UPDATES) {
        this.handleUpdateNotification(message);
      }
    });

    // Load initial tasks
    await this.loadAllTasks();

    // Start polling for CI status
    this.startPolling();

    console.log('[VibeKanban] Integration started');
  }

  /**
   * Stop the integration
   */
  async stop(): Promise<void> {
    console.log('[VibeKanban] Stopping integration...');
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }

    console.log('[VibeKanban] Integration stopped');
  }

  /**
   * Load all tasks from Redis
   */
  private async loadAllTasks(): Promise<void> {
    try {
      const taskIds = await this.redis.smembers(REDIS_KEYS.KANBAN_TASKS);
      console.log(`[VibeKanban] Loading ${taskIds.length} tasks from Redis`);

      for (const taskId of taskIds) {
        const taskData = await this.redis.get(REDIS_KEYS.KANBAN_TASK(taskId));
        if (taskData) {
          try {
            const task = JSON.parse(taskData) as KanbanTaskInstance;
            this.knownTasks.set(taskId, task);
          } catch (e) {
            console.error(`[VibeKanban] Failed to parse task ${taskId}:`, e);
          }
        }
      }

      console.log(`[VibeKanban] Loaded ${this.knownTasks.size} tasks`);
    } catch (e) {
      console.error('[VibeKanban] Failed to load tasks:', e);
    }
  }

  /**
   * Handle update notification from Redis pub/sub
   */
  private async handleUpdateNotification(message: string): Promise<void> {
    try {
      const notification = JSON.parse(message) as UpdateNotification;

      if (notification.eventType === 'task_updated') {
        // Reload the specific task
        const taskData = await this.redis.get(REDIS_KEYS.KANBAN_TASK(notification.taskId));
        if (taskData) {
          const task = JSON.parse(taskData) as KanbanTaskInstance;
          this.knownTasks.set(notification.taskId, task);
          console.log(`[VibeKanban] Task ${notification.taskId} updated`);
        }
      } else if (notification.eventType === 'task_removed') {
        this.knownTasks.delete(notification.taskId);
        console.log(`[VibeKanban] Task ${notification.taskId} removed`);
      }
    } catch (e) {
      // Ignore non-kanban notifications
    }
  }

  /**
   * Start polling for CI status
   */
  private startPolling(): void {
    // Initial poll
    this.pollCiStatus();

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.pollCiStatus();
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Poll CI status for all tasks with open PRs
   */
  private async pollCiStatus(): Promise<void> {
    if (!this.isRunning) return;

    const tasksWithPRs = Array.from(this.knownTasks.values()).filter(
      task => task.prInfo && task.prInfo.status === 'open'
    );

    if (tasksWithPRs.length === 0) {
      console.log('[VibeKanban] No tasks with open PRs to check');
      return;
    }

    console.log(`[VibeKanban] Checking CI status for ${tasksWithPRs.length} tasks`);

    for (const task of tasksWithPRs) {
      if (!this.isRunning) break;

      try {
        const enrichedTask = await this.enrichTaskWithCiStatus(task);
        if (enrichedTask) {
          // Update Redis with enriched data
          await this.publishEnrichedTask(enrichedTask);
        }
      } catch (e) {
        console.error(`[VibeKanban] Failed to check CI for task ${task.taskId}:`, e);
      }
    }
  }

  /**
   * Enrich a task with CI status from GitHub
   */
  private async enrichTaskWithCiStatus(task: KanbanTaskInstance): Promise<KanbanTaskInstance | null> {
    if (!task.prInfo?.url) return null;

    try {
      // Extract repo info from PR URL
      const prUrl = task.prInfo.url;
      const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!match) return null;

      const [, owner, repo, prNumber] = match;

      // Get PR checks using gh CLI
      const checksResult = await $`/opt/homebrew/bin/gh pr checks ${prNumber} --repo=${owner}/${repo} --json bucket,name,state 2>/dev/null || echo ""`.quiet();

      let ciChecks: CiChecksInfo | undefined;
      let ciStatus: 'pending' | 'passing' | 'failing' | undefined;

      if (checksResult.stdout.trim()) {
        const checkResults = JSON.parse(checksResult.stdout);
        const passing = checkResults.filter((c: any) => c.bucket === 'pass').length;
        const failing = checkResults.filter((c: any) => c.bucket === 'fail' || c.bucket === 'cancel').length;
        const pending = checkResults.filter((c: any) => c.bucket === 'pending').length;

        ciChecks = {
          passing,
          failing,
          pending,
          conclusion: pending > 0 ? 'pending' : failing > 0 ? 'failure' : 'success',
          runs: checkResults.map((c: any) => ({
            name: c.name,
            state: c.state,
            bucket: c.bucket,
          })),
        };

        ciStatus = ciChecks.conclusion === 'failure' ? 'failing' :
                   ciChecks.conclusion === 'pending' ? 'pending' : 'passing';
      }

      // Get PR mergeable status
      let mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | undefined;
      try {
        const prResult = await $`/opt/homebrew/bin/gh pr view ${prNumber} --repo=${owner}/${repo} --json mergeable 2>/dev/null || echo ""`.quiet();
        if (prResult.stdout.trim()) {
          const pr = JSON.parse(prResult.stdout);
          mergeable = pr.mergeable;
        }
      } catch {
        // Ignore
      }

      // Create enriched task
      const enrichedTask: KanbanTaskInstance = {
        ...task,
        prStatus: {
          number: Number(prNumber),
          state: 'OPEN',
          mergeable,
          checks: ciChecks,
        },
        updatedAt: new Date().toISOString(),
      };

      // Also update prInfo with CI status
      if (enrichedTask.prInfo) {
        enrichedTask.prInfo = {
          ...enrichedTask.prInfo,
          ci_status: ciStatus,
          ci_checks: ciChecks,
          ci_last_updated_at: new Date().toISOString(),
          mergeable,
        };
      }

      return enrichedTask;
    } catch (e) {
      console.error(`[VibeKanban] Error enriching task ${task.taskId}:`, e);
      return null;
    }
  }

  /**
   * Publish enriched task back to Redis
   */
  private async publishEnrichedTask(task: KanbanTaskInstance): Promise<void> {
    try {
      const taskKey = REDIS_KEYS.KANBAN_TASK(task.taskId);
      await this.redis.set(taskKey, JSON.stringify(task));

      // Also publish to the kanban updates channel
      await this.publisher.publish(REDIS_CHANNELS.KANBAN_UPDATES, JSON.stringify({
        eventType: 'ci_status_updated',
        taskId: task.taskId,
        ciStatus: task.prInfo?.ci_status,
        checks: task.prStatus?.checks,
        mergeable: task.prStatus?.mergeable,
        timestamp: new Date().toISOString(),
      }));

      console.log(`[VibeKanban] Published enriched task ${task.taskId} (CI: ${task.prInfo?.ci_status})`);
    } catch (e) {
      console.error(`[VibeKanban] Failed to publish task ${task.taskId}:`, e);
    }
  }

  /**
   * Get all known tasks (for debugging/API)
   */
  getTasks(): KanbanTaskInstance[] {
    return Array.from(this.knownTasks.values());
  }

  /**
   * Check if integration is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let vibeKanbanInstance: VibeKanbanIntegration | null = null;

export function getVibeKanbanIntegration(): VibeKanbanIntegration {
  if (!vibeKanbanInstance) {
    vibeKanbanInstance = new VibeKanbanIntegration();
  }
  return vibeKanbanInstance;
}

export async function startVibeKanbanIntegration(): Promise<void> {
  const integration = getVibeKanbanIntegration();
  await integration.start();
}

export async function stopVibeKanbanIntegration(): Promise<void> {
  if (vibeKanbanInstance) {
    await vibeKanbanInstance.stop();
  }
}
