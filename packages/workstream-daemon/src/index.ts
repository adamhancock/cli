#!/usr/bin/env tsx

import { $ } from 'zx';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import Redis from 'ioredis';
import {
  getRedisClient,
  getPublisherClient,
  closeRedisConnections,
  REDIS_KEYS,
  REDIS_CHANNELS,
  INSTANCE_TTL
} from './redis-client.js';

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
  };
}

interface ClaudeStatus {
  active: boolean;
  pid: number;
  isWorking: boolean;
  isWaiting?: boolean;
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

interface InstanceWithMetadata extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  caddyHost?: CaddyHost;
  lastUpdated: number;
}

const CACHE_DIR = join(homedir(), '.workstream-daemon');
const CACHE_FILE = join(CACHE_DIR, 'instances.json');
const POLL_INTERVAL = 5000; // 5 seconds (git and Claude are local, fast)
const MIN_POLL_INTERVAL = 120000; // 2 minutes (when rate limited)
const RATE_LIMIT_THRESHOLD = 100; // Start slowing down when remaining < 100

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
  private currentPollInterval: number = POLL_INTERVAL;
  private ghRateLimit?: GitHubRateLimit;

  constructor() {
    this.redis = getRedisClient();
    this.publisher = getPublisherClient();
    this.subscriber = new Redis({
      host: 'localhost',
      port: 6379,
    });
    this.setupSubscriber();
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

    this.subscriber.on('message', async (channel, message) => {
      try {
        const data = JSON.parse(message);
        log(`📨 Received message on ${channel}: ${data.type}`);

        if (channel === REDIS_CHANNELS.REFRESH) {
          // Handle general refresh requests
          if (data.type === 'refresh') {
            log('  🔄 Triggering forced PR refresh');
            this.pollInstances(true); // Force PR refresh
          }
        } else if (channel === REDIS_CHANNELS.CLAUDE) {
          // Handle Claude-specific events
          const projectName = data.path?.split('/').pop() || 'unknown';
          if (data.type === 'work_started') {
            log(`  ▶️  Claude started working in ${projectName}`);
            await this.handleClaudeStarted(data.path);
          } else if (data.type === 'waiting_for_input') {
            log(`  ⏸️  Claude waiting for input in ${projectName}`);
            await this.handleClaudeWaiting(data.path);
          } else if (data.type === 'work_stopped') {
            log(`  ⏹️  Claude stopped in ${projectName}`);
            await this.handleClaudeFinished(data.path);
          }
        }
      } catch (error) {
        logError('Error handling message:', error);
      }
    });
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

    // Ensure cache directory exists
    log('📁 Setting up cache directory...');
    await mkdir(CACHE_DIR, { recursive: true });

    // Check initial rate limit
    log('🔍 Checking GitHub rate limits...');
    await this.checkGitHubRateLimit();

    // Initial poll
    log('🔄 Running initial poll...');
    await this.pollInstances();

    // Start polling with dynamic interval
    this.scheduleNextPoll();

    log('');
    log('✅ Daemon running');
    log(`   Polling interval: ${this.currentPollInterval}ms`);
    log(`   Cache file: ${CACHE_FILE}`);
    log(`   Redis channels:`);
    log(`     - Updates: ${REDIS_CHANNELS.UPDATES}`);
    log(`     - Refresh: ${REDIS_CHANNELS.REFRESH}`);
    log(`     - Claude: ${REDIS_CHANNELS.CLAUDE}`);
    log(`     - Chrome Updates: ${REDIS_CHANNELS.CHROME_UPDATES}`);
    log('');
  }

  private scheduleNextPoll() {
    this.pollTimer = setTimeout(() => {
      this.pollInstances()
        .catch(logError)
        .finally(() => {
          this.scheduleNextPoll();
        });
    }, this.currentPollInterval);
  }

  async stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    // Unsubscribe and close Redis connections
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    await closeRedisConnections();

    log('Daemon stopped');
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

      // Calculate time until reset
      const coreMinutesUntilReset = this.getMinutesUntilReset(coreLimit.reset);
      const graphqlMinutesUntilReset = this.getMinutesUntilReset(graphqlLimit.reset);

      // Log both limits for visibility with reset times
      const corePercent = Math.round((coreLimit.remaining / coreLimit.limit) * 100);
      const graphqlPercent = Math.round((graphqlLimit.remaining / graphqlLimit.limit) * 100);
      log(`GitHub Rate Limits - Core: ${corePercent}% remaining (${coreLimit.remaining}/${coreLimit.limit}), resets in ${coreMinutesUntilReset}m, GraphQL: ${graphqlPercent}% remaining (${graphqlLimit.remaining}/${graphqlLimit.limit}), resets in ${graphqlMinutesUntilReset}m`);

      // Adjust polling interval based on rate limit
      if (this.ghRateLimit!.remaining < RATE_LIMIT_THRESHOLD) {
        this.currentPollInterval = MIN_POLL_INTERVAL;
        log(`⚠️  Rate limit low (${this.ghRateLimit!.remaining} remaining), increasing poll interval to ${MIN_POLL_INTERVAL}ms`);
      } else {
        this.currentPollInterval = POLL_INTERVAL;
      }
    } catch (error) {
      // GitHub CLI not available or not authenticated
      log('Unable to check GitHub rate limit (gh CLI may not be available)');
    }
  }

  private async pollInstances(forcePR: boolean = false) {
    try {
      log(`🔄 Starting poll${forcePR ? ' (forced PR refresh)' : ''}...`);

      // Check rate limit FIRST to have latest values before enriching
      await this.checkGitHubRateLimit();

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
          log(`  ➖ Removed closed instance: ${path.split('/').pop()}`);
        }
      }

      // Log if we're skipping PR status due to rate limiting
      if (this.ghRateLimit && this.ghRateLimit.remaining === 0) {
        log('⚠️  Skipping PR status updates due to rate limit exhaustion');
      }

      // Update or add instances (in parallel for speed)
      const enrichmentTasks: Array<{
        instance: VSCodeInstance;
        shouldUpdatePR: boolean;
        projectName: string;
      }> = [];

      let skippedCount = 0;
      for (const instance of instances) {
        const existing = this.instances.get(instance.path);
        const projectName = instance.path.split('/').pop() || instance.path;

        // Always update git and Claude (local, no rate limits)
        // Only refresh PR status if we have rate limit and it's been 30+ seconds (or forced)
        const shouldUpdateLocal = !existing || (Date.now() - existing.lastUpdated) > 5000; // 5 seconds
        const shouldUpdatePR = forcePR || !existing || (Date.now() - existing.lastUpdated) > 30000; // 30 seconds

        if (shouldUpdateLocal) {
          enrichmentTasks.push({ instance, shouldUpdatePR, projectName });
        } else {
          skippedCount++;
        }
      }

      // Enrich all instances in parallel
      let updatedCount = 0;
      if (enrichmentTasks.length > 0) {
        log(`  🔍 Enriching ${enrichmentTasks.length} instances in parallel...`);
        const enrichmentResults = await Promise.all(
          enrichmentTasks.map(async ({ instance, shouldUpdatePR, projectName }) => {
            try {
              const enriched = await this.enrichInstance(instance, shouldUpdatePR);
              return { success: true, enriched, projectName, shouldUpdatePR };
            } catch (error) {
              logError(`  ❌ Failed to enrich ${projectName}:`, error);
              return { success: false, projectName };
            }
          })
        );

        // Process results and update instances map
        for (const result of enrichmentResults) {
          if (result.success && 'enriched' in result) {
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

      // Get Chrome windows (in parallel with other operations)
      const chromeWindows = await this.getChromeWindows();
      this.chromeWindows = chromeWindows;
      const tabCount = chromeWindows.reduce((sum, w) => sum + w.tabs.length, 0);
      log(`🌐 Found ${chromeWindows.length} Chrome windows with ${tabCount} tabs`);

      // Write to cache file (for compatibility)
      await this.writeCache();
      log(`💾 Wrote cache file`);

      // Publish to Redis
      await this.publishUpdate();
      log(`📡 Published ${this.instances.size} instances to Redis`);

      // Publish Chrome update
      await this.publishChromeUpdate();
      log(`🌐 Published ${chromeWindows.length} Chrome windows to Redis`);

      log(`✅ Poll complete: ${updatedCount} updated, ${skippedCount} skipped, ${removedCount} removed`);
    } catch (error) {
      logError('Error polling instances:', error);
    }
  }

  private async writeCache() {
    const data = {
      instances: Array.from(this.instances.values()),
      timestamp: Date.now(),
    };
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
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

  private async enrichInstance(instance: VSCodeInstance, updatePR: boolean = true): Promise<InstanceWithMetadata> {
    const enriched: InstanceWithMetadata = {
      ...instance,
      lastUpdated: Date.now(),
    };

    // Get git info (local, fast)
    if (instance.isGitRepo) {
      enriched.gitInfo = await this.getGitInfo(instance.path);
    }

    // Get PR status only if requested and we have rate limit remaining
    if (updatePR && enriched.gitInfo && this.ghRateLimit && this.ghRateLimit.remaining > 0) {
      enriched.prStatus = await this.getPRStatus(instance.path, enriched.gitInfo.branch);
    } else {
      // Preserve existing PR status if not updating
      const existing = this.instances.get(instance.path);
      if (existing?.prStatus) {
        enriched.prStatus = existing.prStatus;
      }
    }

    // Get Claude status (local, fast)
    enriched.claudeStatus = await this.getClaudeStatus(instance.path);

    // Get tmux status (local, fast)
    enriched.tmuxStatus = await this.getTmuxStatus(instance.path, enriched.gitInfo?.branch);

    // Get Caddy host info (local API call, fast)
    enriched.caddyHost = await this.getCaddyHost(instance.path);

    return enriched;
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
          const checksInfoResult = await $`/opt/homebrew/bin/gh pr checks ${branch} --repo=${remoteUrlResult.stdout.trim()} --json bucket 2>/dev/null || echo ""`.quiet();

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
      const psResult = await $`/bin/ps aux | grep -E "^\\S+\\s+\\d+.*claude\\s*$" | awk '{print $2}'`;

      const pids = psResult.stdout.trim().split('\n').filter(Boolean);

      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        const lsofResult = await $`/usr/sbin/lsof -p ${pidStr} 2>/dev/null || true`;

        const cwdLine = lsofResult.stdout.split('\n').find((line: string) => line.includes(' cwd '));
        if (cwdLine) {
          const parts = cwdLine.trim().split(/\s+/);
          const cwd = parts[parts.length - 1];

          if (cwd === repoPath) {
            // Get existing status if available to preserve hook-based state
            const existing = this.instances.get(repoPath);
            const isWorking = existing?.claudeStatus?.isWorking ?? false;
            const isWaiting = existing?.claudeStatus?.isWaiting ?? false;

            return { active: true, pid, isWorking, isWaiting };
          }
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
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

  private async handleClaudeStarted(repoPath: string) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        const wasWaiting = instance.claudeStatus.isWaiting;
        instance.claudeStatus.isWorking = true;
        instance.claudeStatus.isWaiting = false;
        await this.writeCache();
        await this.publishUpdate();

        const projectName = repoPath.split('/').pop() || 'project';

        // Only notify when resuming from waiting state (to reduce noise)
        if (wasWaiting) {
          await this.sendNotification(
            'Claude Code',
            `▶️ Claude resumed working in ${projectName}`
          );
        }

        log(`Claude started working in ${projectName}`);
      }
    } catch (error) {
      logError('Error handling Claude started:', error);
    }
  }

  private async handleClaudeWaiting(repoPath: string) {
    try {
      // Update instance status to waiting
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        instance.claudeStatus.isWaiting = true;
        instance.claudeStatus.isWorking = false;
        await this.writeCache();
        await this.publishUpdate();

        // Send notification
        const projectName = repoPath.split('/').pop() || 'project';
        await this.sendNotification(
          'Claude Code',
          `🤔 Claude needs your attention in ${projectName}`
        );

        log(`Claude waiting for input in ${projectName}`);
      }
    } catch (error) {
      logError('Error handling Claude waiting:', error);
    }
  }

  private async handleClaudeFinished(repoPath: string) {
    try {
      // Update instance status to not waiting and not working
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        instance.claudeStatus.isWaiting = false;
        instance.claudeStatus.isWorking = false;
        await this.writeCache();
        await this.publishUpdate();

        // Send notification
        const projectName = repoPath.split('/').pop() || 'project';
        await this.sendNotification(
          'Claude Code',
          `✅ Claude finished working in ${projectName}`
        );

        log(`Claude finished in ${projectName}`);
      }
    } catch (error) {
      logError('Error handling Claude finished:', error);
    }
  }

  private async sendNotification(title: string, message: string) {
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
