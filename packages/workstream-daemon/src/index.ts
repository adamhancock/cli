#!/usr/bin/env tsx

import { $ } from 'zx';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { WebSocketServer } from 'ws';

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

interface InstanceWithMetadata extends VSCodeInstance {
  gitInfo?: GitInfo;
  prStatus?: PRStatus;
  claudeStatus?: ClaudeStatus;
  tmuxStatus?: TmuxStatus;
  lastUpdated: number;
}

const CACHE_DIR = join(homedir(), '.workstream-daemon');
const CACHE_FILE = join(CACHE_DIR, 'instances.json');
const POLL_INTERVAL = 5000; // 5 seconds (git and Claude are local, fast)
const WS_PORT = 58234;
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
  private wss: WebSocketServer;
  private pollTimer?: NodeJS.Timeout;
  private currentPollInterval: number = POLL_INTERVAL;
  private ghRateLimit?: GitHubRateLimit;

  constructor() {
    this.wss = new WebSocketServer({ port: WS_PORT });
    this.setupWebSocket();
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws) => {
      log('Client connected');

      // Send current instances immediately
      ws.send(JSON.stringify({
        type: 'instances',
        data: Array.from(this.instances.values()),
      }));

      ws.on('message', (message) => {
        try {
          const { type, path } = JSON.parse(message.toString());
          if (type === 'refresh') {
            this.pollInstances(true); // Force PR refresh
          } else if (type === 'work_started') {
            this.handleClaudeStarted(path);
          } else if (type === 'waiting_for_input') {
            this.handleClaudeWaiting(path);
          } else if (type === 'work_stopped') {
            this.handleClaudeFinished(path);
          }
        } catch (error) {
          logError('Invalid message:', error);
        }
      });
    });

    log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
  }

  private broadcast() {
    const data = JSON.stringify({
      type: 'instances',
      data: Array.from(this.instances.values()),
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(data);
      }
    });
  }

  async start() {
    log('Workstream Daemon starting...');

    // Ensure cache directory exists
    await mkdir(CACHE_DIR, { recursive: true });

    // Check initial rate limit
    await this.checkGitHubRateLimit();

    // Initial poll
    await this.pollInstances();

    // Start polling with dynamic interval
    this.scheduleNextPoll();

    log(`Daemon running. Initial polling interval: ${this.currentPollInterval}ms`);
    log(`Cache file: ${CACHE_FILE}`);
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
    this.wss.close();
    log('Daemon stopped');
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

      // Log both limits for visibility
      log(`GitHub Rate Limits:`);
      log(`  Core REST: ${coreLimit.remaining}/${coreLimit.limit} (resets at ${new Date(coreLimit.reset * 1000).toLocaleTimeString()})`);
      log(`  GraphQL: ${graphqlLimit.remaining}/${graphqlLimit.limit} (resets at ${new Date(graphqlLimit.reset * 1000).toLocaleTimeString()})`);

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
      // Check rate limit FIRST to have latest values before enriching
      await this.checkGitHubRateLimit();

      const instances = await this.getVSCodeInstances();

      // Update instances map
      const newPaths = new Set(instances.map(i => i.path));

      // Remove instances that no longer exist
      for (const [path] of this.instances) {
        if (!newPaths.has(path)) {
          this.instances.delete(path);
        }
      }

      // Log if we're skipping PR status due to rate limiting
      if (this.ghRateLimit && this.ghRateLimit.remaining === 0) {
        log('⚠️  Skipping PR status updates due to rate limit exhaustion');
      }

      // Update or add instances
      for (const instance of instances) {
        const existing = this.instances.get(instance.path);

        // Always update git and Claude (local, no rate limits)
        // Only refresh PR status if we have rate limit and it's been 30+ seconds (or forced)
        const shouldUpdateLocal = !existing || (Date.now() - existing.lastUpdated) > 5000; // 5 seconds
        const shouldUpdatePR = forcePR || !existing || (Date.now() - existing.lastUpdated) > 30000; // 30 seconds

        if (shouldUpdateLocal) {
          const enriched = await this.enrichInstance(instance, shouldUpdatePR);
          this.instances.set(instance.path, enriched);
        }
      }

      // Write to cache file
      await this.writeCache();

      // Broadcast to connected clients
      this.broadcast();

      log(`Updated ${this.instances.size} instances${forcePR ? ' (forced PR refresh)' : ''}`);
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

  private async handleClaudeStarted(repoPath: string) {
    try {
      const instance = this.instances.get(repoPath);
      if (instance && instance.claudeStatus) {
        instance.claudeStatus.isWorking = true;
        instance.claudeStatus.isWaiting = false;
        await this.writeCache();
        this.broadcast();

        const projectName = repoPath.split('/').pop() || 'project';
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
        this.broadcast();

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
        this.broadcast();

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
