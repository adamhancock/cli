import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow } from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import { exec } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';
import { getVSCodeInstances, focusVSCodeInstance, closeVSCodeInstance, launchClaudeTerminal } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getPRStatus } from './utils/github';
import { isClaudeCodeActive } from './utils/claude';
import { getCachedInstances, setCachedInstances, clearCache, recordUsage, getUsageHistory } from './utils/cache';
import { loadFromDaemon, loadFromRedis, triggerDaemonRefresh, clearClaudeFinishedFlag, subscribeToUpdates, type DaemonCache } from './utils/daemon-client';
import { getTmuxSessionOutput, createTmuxSession, attachToTmuxSession, killTmuxSession, detectPackageManager } from './utils/tmux';
import { startNotificationListener, stopNotificationListener } from './utils/notification-listener';
import type { InstanceWithStatus } from './types';

const execAsync = promisify(exec);

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

// Helper functions for Chrome tab management
function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove protocol, trailing slashes, and www for consistent comparison
    const hostname = urlObj.hostname.replace(/^www\./, '');
    const pathname = urlObj.pathname.replace(/\/$/, '');
    return `${hostname}${pathname}${urlObj.search}${urlObj.hash}`;
  } catch {
    return url;
  }
}

// Helper to safely get timestamp from lastActivityTime (handles both Date and string)
function getActivityTimestamp(lastActivityTime: Date | string | undefined): number {
  if (!lastActivityTime) return 0;
  if (lastActivityTime instanceof Date) return lastActivityTime.getTime();
  return new Date(lastActivityTime).getTime();
}

async function getChromeWindows(): Promise<ChromeWindow[]> {
  try {
    const redis = new Redis({
      host: 'localhost',
      port: 6379,
    });

    const data = await redis.get('workstream:chrome:windows');
    await redis.quit();

    if (data) {
      return JSON.parse(data) as ChromeWindow[];
    }
  } catch (error) {
    console.error('Failed to load Chrome windows:', error);
  }
  return [];
}

async function findChromeTab(targetUrl: string): Promise<{ windowId: number; tabIndex: number } | null> {
  const windows = await getChromeWindows();
  const normalizedTarget = normalizeUrl(targetUrl);

  for (const window of windows) {
    for (const tab of window.tabs) {
      if (normalizeUrl(tab.url) === normalizedTarget) {
        return { windowId: window.id, tabIndex: tab.index };
      }
    }
  }

  return null;
}

async function switchToChromeTab(windowId: number, tabIndex: number) {
  const script = `
    tell application "Google Chrome"
      activate
      set _wnd to first window where id is ${windowId}
      set index of _wnd to 1
      set active tab index of _wnd to ${tabIndex + 1}
    end tell
  `;
  await execAsync(`osascript -e '${script}'`);
}

async function openNewChromeTab(url: string) {
  // Escape single quotes in URL
  const escapedUrl = url.replace(/'/g, "'\"'\"'");
  const script = `
    tell application "Google Chrome"
      activate
      open location "${escapedUrl}"
    end tell
  `;
  await execAsync(`osascript -e '${script}'`);
}

export default function Command() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [chromeWindows, setChromeWindows] = useState<ChromeWindow[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Initial load
  useEffect(() => {
    loadInstances();
  }, []);

  // Subscribe to real-time updates from daemon
  useEffect(() => {
    console.log('Setting up WebSocket subscription...');

    const cleanup = subscribeToUpdates(
      (updatedInstances, timestamp) => {
        console.log('Received real-time update:', updatedInstances.length);
        setIsRealtimeMode(true);
        setInstances(sortByUsageHistory(updatedInstances));
        setLastRefreshTime(timestamp ? new Date(timestamp) : new Date());
        setIsLoading(false);
      },
      () => {
        // On error, fall back to polling/cache mode
        console.log('WebSocket error, falling back to cache mode');
        setIsRealtimeMode(false);
      }
    );

    cleanupRef.current = cleanup;

    // Cleanup on unmount
    return () => {
      console.log('Cleaning up WebSocket connection');
      cleanup();
    };
  }, []);

  // Load Chrome windows for tab detection
  useEffect(() => {
    loadChromeWindows();
  }, []);

  // Start notification listener
  useEffect(() => {
    console.log('Starting notification listener...');
    startNotificationListener();

    // Cleanup on unmount
    return () => {
      console.log('Stopping notification listener...');
      stopNotificationListener();
    };
  }, []);

  async function loadChromeWindows() {
    try {
      const windows = await getChromeWindows();
      setChromeWindows(windows);
    } catch (error) {
      console.error('Failed to load Chrome windows:', error);
    }
  }

  async function loadInstances(forceRefresh = false, includePR = false) {
    setIsLoading(true);

    // If force refresh, trigger daemon to refetch immediately
    if (forceRefresh) {
      const triggered = await triggerDaemonRefresh();
      if (triggered) {
        console.log('Triggered daemon refresh');
        // Wait a bit for daemon to update Redis/cache
        await new Promise(resolve => setTimeout(resolve, 500));
        // Redis pub/sub will automatically update the UI, so we can return early
        if (isRealtimeMode) {
          setIsLoading(false);
          return;
        }
      }
    }

    // If we're in real-time mode and not forcing a refresh, let Redis pub/sub handle updates
    if (isRealtimeMode && !forceRefresh && instances.length > 0) {
      console.log('Using real-time mode, skipping manual fetch');
      setIsLoading(false);
      return;
    }

    // Try to load from Redis first (fastest - direct access)
    if (!forceRefresh) {
      const redisCache = await loadFromRedis();
      if (redisCache && redisCache.instances.length > 0) {
        console.log('Using Redis cache:', redisCache.instances.length);
        setInstances(sortByUsageHistory(redisCache.instances));
        setLastRefreshTime(new Date(redisCache.timestamp));
        setIsLoading(false);
        return;
      }

      // Fallback to file cache if Redis not available
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        console.log('Using daemon file cache:', daemonCache.instances.length);
        setInstances(sortByUsageHistory(daemonCache.instances));
        setLastRefreshTime(new Date(daemonCache.timestamp));
        setIsLoading(false);
        return;
      }
    } else {
      // On force refresh, always try Redis first (it should have fresh data now)
      const redisCache = await loadFromRedis();
      if (redisCache && redisCache.instances.length > 0) {
        console.log('Using refreshed Redis cache:', redisCache.instances.length);
        setInstances(sortByUsageHistory(redisCache.instances));
        setLastRefreshTime(new Date(redisCache.timestamp));
        setIsLoading(false);
        return;
      }

      // Fallback to file cache
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        console.log('Using refreshed daemon file cache:', daemonCache.instances.length);
        setInstances(sortByUsageHistory(daemonCache.instances));
        setLastRefreshTime(new Date(daemonCache.timestamp));
        setIsLoading(false);
        return;
      }
    }

    // Try to load from Raycast cache (unless force refresh)
    if (!forceRefresh) {
      const cached = getCachedInstances();
      if (cached && cached.length > 0) {
        console.log('Using Raycast cache:', cached.length);
        setInstances(sortByUsageHistory(cached));
        // Don't set lastRefreshTime here - we don't have the daemon timestamp
        setIsLoading(false);
        return;
      }
    }

    try {
      // Get basic VS Code instances
      console.log('Starting to load VS Code instances...');
      const basicInstances = await getVSCodeInstances();
      console.log('Found instances:', basicInstances.length);

      if (basicInstances.length === 0) {
        console.log('No instances found');
        setInstances([]);
        setIsLoading(false);
        setCachedInstances([]); // Cache empty result
        return;
      }

      // Show instances immediately with basic info (sorted)
      setInstances(sortByUsageHistory(basicInstances));
      setIsLoading(false);

      // Enrich with metadata in the background - but do it progressively
      // First pass: git info only (fastest)
      const withGitInfo = await Promise.all(
        basicInstances.map(async (instance) => {
          const enriched: InstanceWithStatus = { ...instance };
          try {
            if (instance.isGitRepo) {
              enriched.gitInfo = (await getGitInfo(instance.path)) || undefined;
            }
          } catch (error) {
            // Silently fail, continue with other instances
          }
          return enriched;
        })
      );
      setInstances(sortByUsageHistory(withGitInfo));

      // Second pass: PR status and Claude (slower, network calls)
      // Note: Caddy host info now comes from the daemon automatically
      const fullyEnriched = await Promise.all(
        withGitInfo.map(async (instance) => {
          const enriched: InstanceWithStatus = { ...instance };
          try {
            // Get PR status (can be slow - GitHub API)
            if (enriched.gitInfo) {
              enriched.prStatus = (await getPRStatus(instance.path, enriched.gitInfo.branch)) || undefined;
            }

            // Get Claude status (fast - local check)
            const claudeSession = await isClaudeCodeActive(instance.path);
            if (claudeSession) {
              enriched.claudeStatus = {
                active: true,
                pid: claudeSession.pid,
                ideName: claudeSession.ideName,
                isWorking: claudeSession.isWorking,
                lastActivityTime: claudeSession.lastActivityTime,
              };
            }
          } catch (error) {
            enriched.error = error instanceof Error ? error.message : 'Unknown error';
          }
          return enriched;
        })
      );

      const sortedEnriched = sortByUsageHistory(fullyEnriched);
      setInstances(sortedEnriched);
      // Don't set lastRefreshTime here - this is a direct fetch, not from daemon

      // Cache the fully enriched instances (sorted)
      setCachedInstances(sortedEnriched);
    } catch (error) {
      console.error('Error in loadInstances:', error);
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load VS Code instances',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
    }
    // Note: setIsLoading(false) is called earlier now for better UX
  }

  async function switchToInstance(instance: InstanceWithStatus) {
    try {
      // Record usage for sorting next time
      recordUsage(instance.path);

      // Clear finished flag when switching to instance
      if (instance.claudeStatus?.claudeFinished) {
        await clearClaudeFinishedFlag(instance.path);
      }

      await focusVSCodeInstance(instance.path);

      // Close Raycast window immediately after switching
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to switch window',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  function isPROpenInChrome(instance: InstanceWithStatus): boolean {
    if (!instance.prStatus) return false;

    const normalizedTarget = normalizeUrl(instance.prStatus.url);

    for (const window of chromeWindows) {
      for (const tab of window.tabs) {
        if (normalizeUrl(tab.url) === normalizedTarget) {
          return true;
        }
      }
    }

    return false;
  }

  function getSpotlightUrl(instance: InstanceWithStatus): string | null {
    if (!instance.caddyHost) return null;

    try {
      const url = new URL(instance.caddyHost.url);
      // Spotlight UI is on port 8888
      return `https://${url.hostname}:8888`;
    } catch {
      return null;
    }
  }

  function sortByUsageHistory(instances: InstanceWithStatus[]): InstanceWithStatus[] {
    const usageHistory = getUsageHistory();

    return [...instances].sort((a, b) => {
      const aTime = usageHistory[a.path] || 0;
      const bTime = usageHistory[b.path] || 0;

      // Most recently used first
      if (aTime !== bTime) {
        return bTime - aTime;
      }

      // If both never used or same time, sort alphabetically
      return a.name.localeCompare(b.name);
    });
  }

  function getRelativeTimeString(date: Date | null): string {
    if (!date) return '';

    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function getStatusIcon(instance: InstanceWithStatus): Icon {
    // Check Claude finished status first - highest priority
    if (instance.claudeStatus?.claudeFinished) {
      return Icon.Check;
    }

    // Check Claude waiting status - second priority
    if (instance.claudeStatus?.active && instance.claudeStatus.isWaiting) {
      return Icon.MagnifyingGlass;
    }

    // Check Claude working status - third priority
    if (instance.claudeStatus?.active && instance.claudeStatus.isWorking) {
      return Icon.Bolt;
    }

    // Check OpenCode finished status
    if (instance.opencodeStatus?.opencodeFinished) {
      return Icon.Check;
    }

    // Check OpenCode waiting status (only when explicitly waiting for input)
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWaiting) {
      return Icon.MagnifyingGlass;
    }

    // Check OpenCode working status
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWorking) {
      return Icon.Bolt;
    }

    // Check OpenCode idle status (active but not working or waiting)
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isIdle) {
      return Icon.Bolt; // Same icon as idle Claude
    }

    // Check for merge conflicts - blocking issue
    if (instance.prStatus?.mergeable === 'CONFLICTING') {
      return Icon.ExclamationMark;
    }

    // Check PR state
    if (instance.prStatus?.state === 'MERGED') {
      return Icon.CheckCircle;
    }
    if (instance.prStatus?.state === 'CLOSED') {
      return Icon.XMarkCircle;
    }

    // Then check CI status for open PRs
    if (instance.prStatus?.checks) {
      if (instance.prStatus.checks.conclusion === 'success') {
        return Icon.CheckCircle;
      } else if (instance.prStatus.checks.conclusion === 'failure') {
        return Icon.XMarkCircle;
      } else {
        return Icon.Clock;
      }
    }
    return Icon.Folder;
  }

  function getStatusColor(instance: InstanceWithStatus): Color {
    // Check Claude finished status first - highest priority (green)
    if (instance.claudeStatus?.claudeFinished) {
      return Color.Green;
    }

    // Check Claude working status - second priority (purple)
    if (instance.claudeStatus?.active && instance.claudeStatus.isWorking) {
      return Color.Purple;
    }

    // Check Claude waiting status (orange)
    if (instance.claudeStatus?.active && instance.claudeStatus.isWaiting) {
      return Color.Orange;
    }

    // Check OpenCode finished status (green)
    if (instance.opencodeStatus?.opencodeFinished) {
      return Color.Green;
    }

    // Check OpenCode working status (blue)
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWorking) {
      return Color.Blue;
    }

    // Check OpenCode waiting status (orange) - only when explicitly waiting for input
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWaiting) {
      return Color.Orange;
    }

    // Check OpenCode idle status (secondary/grey)
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isIdle) {
      return Color.SecondaryText;
    }

    // Check for merge conflicts - red for blocking issue
    if (instance.prStatus?.mergeable === 'CONFLICTING') {
      return Color.Red;
    }

    // Check PR state
    if (instance.prStatus?.state === 'MERGED') {
      return Color.Purple;
    }
    if (instance.prStatus?.state === 'CLOSED') {
      return Color.SecondaryText;
    }

    // Then check CI status for open PRs
    if (instance.prStatus?.checks) {
      if (instance.prStatus.checks.conclusion === 'success') {
        return Color.Green;
      } else if (instance.prStatus.checks.conclusion === 'failure') {
        return Color.Red;
      } else {
        return Color.Yellow;
      }
    }
    return Color.PrimaryText;
  }

  function getStatusTooltip(instance: InstanceWithStatus): string {
    // Check Claude finished status first - highest priority
    if (instance.claudeStatus?.claudeFinished) {
      return 'Claude Code: Work completed';
    }

    // Check Claude waiting status - second priority
    if (instance.claudeStatus?.active && instance.claudeStatus.isWaiting) {
      return 'Claude Code: Waiting for input';
    }

    // Check Claude working status - third priority
    if (instance.claudeStatus?.active && instance.claudeStatus.isWorking) {
      return 'Claude Code: Actively working';
    }

    // Check OpenCode finished status
    if (instance.opencodeStatus?.opencodeFinished) {
      return 'OpenCode: Work completed';
    }

    // Check OpenCode waiting status (only when explicitly waiting for input)
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWaiting) {
      return 'OpenCode: Waiting for input';
    }

    // Check OpenCode working status
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isWorking) {
      return 'OpenCode: Actively working';
    }

    // Check OpenCode idle status
    if (instance.opencodeStatus?.active && instance.opencodeStatus.isIdle) {
      return 'OpenCode: Idle (no recent activity)';
    }

    // Check for merge conflicts - blocking issue
    if (instance.prStatus?.mergeable === 'CONFLICTING') {
      return `PR #${instance.prStatus.number}: Has merge conflicts`;
    }

    // Check PR state
    if (instance.prStatus?.state === 'MERGED') {
      return `PR #${instance.prStatus.number}: Merged`;
    }
    if (instance.prStatus?.state === 'CLOSED') {
      return `PR #${instance.prStatus.number}: Closed`;
    }

    // Then check CI status for open PRs
    if (instance.prStatus?.checks) {
      if (instance.prStatus.checks.conclusion === 'success') {
        return `PR #${instance.prStatus.number}: All checks passing`;
      } else if (instance.prStatus.checks.conclusion === 'failure') {
        return `PR #${instance.prStatus.number}: ${instance.prStatus.checks.failing} check(s) failing`;
      } else {
        return `PR #${instance.prStatus.number}: Checks running`;
      }
    }

    // Default
    if (instance.isGitRepo) {
      return 'Git repository';
    }
    return 'Project folder';
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    // Branch name with icon
    if (instance.gitInfo) {
      parts.push(`⎇ ${instance.gitInfo.branch}`);

      // PR info (compact) - show PR number with status emoji
      if (instance.prStatus) {
        let prDisplay = `#${instance.prStatus.number}`;

        if (instance.prStatus.state === 'OPEN') {
          // Add check status for open PRs
          if (instance.prStatus.checks) {
            if (instance.prStatus.checks.conclusion === 'success') {
              prDisplay += ' ✅';
            } else if (instance.prStatus.checks.conclusion === 'failure') {
              prDisplay += ' ❌';
            } else if (instance.prStatus.checks.conclusion === 'pending') {
              prDisplay += ' 🟡';
            }
          }
          // Add merge conflict warning
          if (instance.prStatus.mergeable === 'CONFLICTING') {
            prDisplay += ' ⚠️';
          }
        } else if (instance.prStatus.state === 'MERGED') {
          prDisplay += ' ✓';
        } else if (instance.prStatus.state === 'CLOSED') {
          prDisplay += ' ✗';
        }

        parts.push(prDisplay);
      }

      // Working directory status - compact format
      if (instance.gitInfo.isDirty) {
        if (instance.gitInfo.modified > 0) {
          parts.push(`±${instance.gitInfo.modified}`);
        }
        if (instance.gitInfo.staged > 0) {
          parts.push(`●${instance.gitInfo.staged}`);
        }
        if (instance.gitInfo.untracked > 0) {
          parts.push(`?${instance.gitInfo.untracked}`);
        }
      } else {
        parts.push('✓');
      }

      // Ahead/behind
      if (instance.gitInfo.ahead && instance.gitInfo.ahead > 0) {
        parts.push(`↑${instance.gitInfo.ahead}`);
      }
      if (instance.gitInfo.behind && instance.gitInfo.behind > 0) {
        parts.push(`↓${instance.gitInfo.behind}`);
      }
    }

    return parts.length > 0 ? `[${parts.join(' ')}]` : '';
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    // PR status section
    if (instance.prStatus) {
      // Chrome tab indicator - show if PR is open in Chrome
      if (isPROpenInChrome(instance)) {
        accessories.push({
          icon: { source: Icon.Globe, tintColor: Color.Blue },
          tooltip: 'PR open in Chrome',
        });
      }

      // PR state icon
      if (instance.prStatus.state === 'MERGED') {
        accessories.push({
          icon: { source: Icon.CheckCircle, tintColor: Color.Purple },
          tooltip: 'PR merged',
        });
      } else if (instance.prStatus.state === 'CLOSED') {
        accessories.push({
          icon: { source: Icon.XMarkCircle, tintColor: Color.SecondaryText },
          tooltip: 'PR closed',
        });
      } else if (instance.prStatus.state === 'OPEN') {
        accessories.push({
          icon: { source: Icon.Circle, tintColor: Color.Green },
          tooltip: 'PR open',
        });
      }

      // Claude status - prioritized before CI checks
      if (instance.claudeStatus?.active) {
        const isFinished = instance.claudeStatus.claudeFinished;
        const isWaiting = instance.claudeStatus.isWaiting;
        const isWorking = instance.claudeStatus.isWorking;

        let statusText: string;
        let tooltip: string;
        let color: Color;
        let icon: Icon;

        if (isFinished) {
          statusText = 'Finished';
          tooltip = 'Claude Code: Work completed ✅';
          color = Color.Green;
          icon = Icon.Check;
        } else if (isWaiting) {
          statusText = 'Waiting';
          tooltip = 'Claude Code: Waiting for your input ⏳';
          color = Color.Orange;
          icon = Icon.MagnifyingGlass;
        } else if (isWorking) {
          statusText = 'Working';
          tooltip = 'Claude Code: Actively working 🔥';
          color = Color.Purple;
          icon = Icon.Bolt;
        } else {
          statusText = 'Idle';
          tooltip = 'Claude Code: Idle (no recent activity)';
          color = Color.SecondaryText;
          icon = Icon.Bolt;
        }

        accessories.push({
          text: statusText,
          icon: { source: icon, tintColor: color },
          tooltip,
        });
      }

      // CI checks summary
      if (instance.prStatus.checks) {
        const { passing, failing, pending, total, conclusion } = instance.prStatus.checks;
        let checkIcon: Icon;
        let checkColor: Color;

        if (conclusion === 'success') {
          checkIcon = Icon.Check;
          checkColor = Color.Green;
        } else if (conclusion === 'failure') {
          checkIcon = Icon.XMarkCircle;
          checkColor = Color.Red;
        } else {
          checkIcon = Icon.Clock;
          checkColor = Color.Yellow;
        }

        accessories.push({
          text: `${passing}/${total}`,
          icon: { source: checkIcon, tintColor: checkColor },
          tooltip: `Checks: ${passing} passing${failing > 0 ? `, ${failing} failing` : ''}${pending > 0 ? `, ${pending} pending` : ''}`,
        });
      }

      // Merge conflict warning
      if (instance.prStatus.mergeable === 'CONFLICTING') {
        accessories.push({
          icon: { source: Icon.ExclamationMark, tintColor: Color.Red },
          tooltip: 'PR has merge conflicts',
        });
      }

      // Show preview label icon
      if (instance.prStatus.labels?.includes('preview')) {
        accessories.push({
          icon: { source: Icon.Eye, tintColor: Color.Blue },
          tooltip: 'Preview deployment available',
        });
      }
    }

    // Claude status for instances without PR (moved outside prStatus block)
    if (!instance.prStatus && instance.claudeStatus?.active) {
      const isFinished = instance.claudeStatus.claudeFinished;
      const isWaiting = instance.claudeStatus.isWaiting;
      const isWorking = instance.claudeStatus.isWorking;

      let statusText: string;
      let tooltip: string;
      let color: Color;
      let icon: Icon;

      if (isFinished) {
        statusText = 'Finished';
        tooltip = 'Claude Code: Work completed ✅';
        color = Color.Green;
        icon = Icon.Check;
      } else if (isWaiting) {
        statusText = 'Waiting';
        tooltip = 'Claude Code: Waiting for your input ⏳';
        color = Color.Orange;
        icon = Icon.MagnifyingGlass;
      } else if (isWorking) {
        statusText = 'Working';
        tooltip = 'Claude Code: Actively working 🔥';
        color = Color.Purple;
        icon = Icon.Bolt;
      } else {
        statusText = 'Idle';
        tooltip = 'Claude Code: Idle (no recent activity)';
        color = Color.SecondaryText;
        icon = Icon.Bolt;
      }

      accessories.push({
        text: statusText,
        icon: { source: icon, tintColor: color },
        tooltip,
      });
    }

    // OpenCode status - show individual sessions if multiple
    if (instance.opencodeStatus?.active || instance.opencodeStatus?.opencodeFinished) {
      const sessions = instance.opencodeStatus.sessions;
      const sessionCount = sessions ? Object.keys(sessions).length : 0;
      
      // If multiple sessions, show each one
      if (sessions && sessionCount > 1) {
        for (const [pidStr, session] of Object.entries(sessions)) {
          let statusText: string;
          let tooltip: string;
          let color: Color;
          let iconType: Icon;
          
          if (session.status === 'working') {
            statusText = `OC:${pidStr.slice(-4)}`;
            tooltip = `OpenCode PID ${pidStr}: Working`;
            color = Color.Blue;
            iconType = Icon.Bolt;
          } else if (session.status === 'waiting') {
            statusText = `OC:${pidStr.slice(-4)}`;
            tooltip = `OpenCode PID ${pidStr}: Waiting for input`;
            color = Color.Orange;
            iconType = Icon.MagnifyingGlass;
          } else if (session.status === 'idle') {
            statusText = `OC:${pidStr.slice(-4)}`;
            tooltip = `OpenCode PID ${pidStr}: Idle`;
            color = Color.SecondaryText;
            iconType = Icon.Bolt;
          } else {
            statusText = `OC:${pidStr.slice(-4)}`;
            tooltip = `OpenCode PID ${pidStr}: ${session.status}`;
            color = Color.SecondaryText;
            iconType = Icon.Bolt;
          }
          
          accessories.push({
            text: statusText,
            icon: { source: iconType, tintColor: color },
            tooltip,
          });
        }
      } else {
        // Single session or legacy format - show aggregate status
        const isFinished = instance.opencodeStatus.opencodeFinished;
        const isWaiting = instance.opencodeStatus.isWaiting;
        const isWorking = instance.opencodeStatus.isWorking;
        const isIdle = instance.opencodeStatus.isIdle;

        let statusText: string;
        let tooltip: string;
        let color: Color;
        let iconType: Icon;

        if (isFinished) {
          statusText = 'OC Finished';
          tooltip = 'OpenCode: Work completed';
          color = Color.Green;
          iconType = Icon.Check;
        } else if (isWaiting) {
          statusText = 'OC Waiting';
          tooltip = 'OpenCode: Waiting for your input';
          color = Color.Orange;
          iconType = Icon.MagnifyingGlass;
        } else if (isWorking) {
          statusText = 'OC Working';
          tooltip = 'OpenCode: Actively working';
          color = Color.Blue;
          iconType = Icon.Bolt;
        } else if (isIdle) {
          statusText = 'OC Idle';
          tooltip = 'OpenCode: Idle (no recent activity)';
          color = Color.SecondaryText;
          iconType = Icon.Bolt;
        } else {
          statusText = 'OC Active';
          tooltip = 'OpenCode: Active';
          color = Color.SecondaryText;
          iconType = Icon.Bolt;
        }

        // Add metrics to tooltip if available
        if (instance.opencodeStatus.metrics) {
          const { filesEdited, commandsRun } = instance.opencodeStatus.metrics;
          if (filesEdited > 0 || commandsRun > 0) {
            tooltip += ` | ${filesEdited} files, ${commandsRun} commands`;
          }
        }

        accessories.push({
          text: statusText,
          icon: { source: iconType, tintColor: color },
          tooltip,
        });
      }
    }

    // Show tmux session status
    if (instance.tmuxStatus?.exists) {
      accessories.push({
        icon: { source: Icon.Terminal, tintColor: Color.Green },
        tooltip: `tmux session: ${instance.tmuxStatus.name}`,
      });
    }

    // Show Caddy host status
    if (instance.caddyHost) {
      accessories.push({
        icon: { source: Icon.Link, tintColor: Color.Blue },
        tooltip: `Dev environment: ${instance.caddyHost.url}`,
      });
    }

    if (instance.gitInfo?.isDirty) {
      const { modified, staged, untracked } = instance.gitInfo;
      const changes = modified + staged + untracked;
      accessories.push({
        text: `${changes} changes`,
        tooltip: `${modified} modified, ${staged} staged, ${untracked} untracked`,
      });
    }

    return accessories;
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={
        isRealtimeMode
          ? `Search VS Code instances... ⚡ Real-time${lastRefreshTime ? ` • GitHub data ${getRelativeTimeString(lastRefreshTime)}` : ''}`
          : `Search VS Code instances...${lastRefreshTime ? ` • GitHub data ${getRelativeTimeString(lastRefreshTime)}` : ''}`
      }
    >
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Window}
          title="No VS Code instances detected"
          description="Open a folder in VS Code to see it here"
        />
      ) : (
        instances.map((instance) => (
          <List.Item
            key={instance.path}
            icon={{ source: getStatusIcon(instance), tintColor: getStatusColor(instance), tooltip: getStatusTooltip(instance) }}
            title={instance.name}
            subtitle={getSubtitle(instance)}
            accessories={getAccessories(instance)}
            detail={
              <List.Item.Detail
                markdown={getDetailMarkdown(instance)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Path" text={instance.path} />

                    {instance.gitInfo && (
                      <>
                        <List.Item.Detail.Metadata.Separator />
                        <List.Item.Detail.Metadata.Label title="Branch" text={instance.gitInfo.branch} />

                        {instance.gitInfo.remoteBranch && (
                          <List.Item.Detail.Metadata.Label
                            title="Remote Branch"
                            text={instance.gitInfo.remoteBranch}
                          />
                        )}

                        {(instance.gitInfo.ahead !== undefined || instance.gitInfo.behind !== undefined) && (
                          <List.Item.Detail.Metadata.Label
                            title="Sync Status"
                            text={`↑${instance.gitInfo.ahead || 0} ↓${instance.gitInfo.behind || 0}`}
                          />
                        )}

                        <List.Item.Detail.Metadata.Label
                          title="Status"
                          text={instance.gitInfo.isDirty ? 'Dirty' : 'Clean'}
                        />

                        {instance.gitInfo.isDirty && (
                          <List.Item.Detail.Metadata.Label
                            title="Changes"
                            text={`${instance.gitInfo.modified} modified, ${instance.gitInfo.staged} staged, ${instance.gitInfo.untracked} untracked`}
                          />
                        )}

                        {instance.gitInfo.lastCommit && (
                          <>
                            <List.Item.Detail.Metadata.Separator />
                            <List.Item.Detail.Metadata.Label
                              title="Last Commit"
                              text={instance.gitInfo.lastCommit.message}
                            />
                            <List.Item.Detail.Metadata.Label
                              title="Author"
                              text={`${instance.gitInfo.lastCommit.author} • ${instance.gitInfo.lastCommit.date}`}
                            />
                          </>
                        )}
                      </>
                    )}

                    {instance.prStatus && (
                      <>
                        <List.Item.Detail.Metadata.Separator />
                        <List.Item.Detail.Metadata.Link
                          title={`PR #${instance.prStatus.number}`}
                          text={instance.prStatus.title}
                          target={instance.prStatus.url}
                        />
                        <List.Item.Detail.Metadata.Label title="State" text={instance.prStatus.state} />
                        <List.Item.Detail.Metadata.Label title="Author" text={instance.prStatus.author} />

                        {instance.prStatus.mergeable && (
                          <List.Item.Detail.Metadata.TagList title="Mergeable">
                            <List.Item.Detail.Metadata.TagList.Item
                              text={
                                instance.prStatus.mergeable === 'MERGEABLE'
                                  ? 'Ready to merge'
                                  : instance.prStatus.mergeable === 'CONFLICTING'
                                    ? 'Has conflicts'
                                    : 'Calculating...'
                              }
                              color={
                                instance.prStatus.mergeable === 'MERGEABLE'
                                  ? Color.Green
                                  : instance.prStatus.mergeable === 'CONFLICTING'
                                    ? Color.Red
                                    : Color.Yellow
                              }
                            />
                          </List.Item.Detail.Metadata.TagList>
                        )}

                        {instance.prStatus.checks && (
                          <>
                            <List.Item.Detail.Metadata.Separator />
                            <List.Item.Detail.Metadata.Label
                              title="Checks"
                              text={`${instance.prStatus.checks.passing} passing, ${instance.prStatus.checks.failing} failing, ${instance.prStatus.checks.pending} pending`}
                            />
                            <List.Item.Detail.Metadata.TagList title="Status">
                              <List.Item.Detail.Metadata.TagList.Item
                                text={instance.prStatus.checks.conclusion}
                                color={
                                  instance.prStatus.checks.conclusion === 'success'
                                    ? Color.Green
                                    : instance.prStatus.checks.conclusion === 'failure'
                                      ? Color.Red
                                      : Color.Yellow
                                }
                              />
                            </List.Item.Detail.Metadata.TagList>
                          </>
                        )}
                      </>
                    )}

                    {instance.claudeStatus && (
                      <>
                        <List.Item.Detail.Metadata.Separator />
                        <List.Item.Detail.Metadata.Label
                          title="Claude Code"
                          text={instance.claudeStatus.isWorking ? 'Working 🔥' : 'Idle 💤'}
                        />
                        <List.Item.Detail.Metadata.Label title="PID" text={instance.claudeStatus.pid.toString()} />
                        {instance.claudeStatus.lastActivityTime && (
                          <List.Item.Detail.Metadata.Label
                            title="Last Activity"
                            text={
                              Math.floor((Date.now() - getActivityTimestamp(instance.claudeStatus.lastActivityTime)) / 1000) < 60
                                ? 'Just now'
                                : `${Math.floor((Date.now() - getActivityTimestamp(instance.claudeStatus.lastActivityTime)) / 60000)} min ago`
                            }
                          />
                        )}
                      </>
                    )}

                    {instance.tmuxStatus && (
                      <>
                        <List.Item.Detail.Metadata.Separator />
                        <List.Item.Detail.Metadata.Label
                          title="Tmux Session"
                          text={instance.tmuxStatus.name}
                        />
                        <List.Item.Detail.Metadata.TagList title="Status">
                          <List.Item.Detail.Metadata.TagList.Item
                            text={instance.tmuxStatus.exists ? 'Active' : 'Not running'}
                            color={instance.tmuxStatus.exists ? Color.Green : Color.SecondaryText}
                          />
                        </List.Item.Detail.Metadata.TagList>
                      </>
                    )}

                    {instance.caddyHost && (
                      <>
                        <List.Item.Detail.Metadata.Separator />
                        <List.Item.Detail.Metadata.Link
                          title="Dev Environment"
                          text={instance.caddyHost.name}
                          target={instance.caddyHost.url}
                        />
                        {instance.caddyHost.upstreams && instance.caddyHost.upstreams.length > 0 && (
                          <List.Item.Detail.Metadata.Label
                            title="Backend"
                            text={instance.caddyHost.upstreams.join(', ')}
                          />
                        )}
                      </>
                    )}
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action title="Switch to Window" onAction={() => switchToInstance(instance)} icon={Icon.Window} />
                <Action
                  title="Refresh"
                  onAction={() => loadInstances(true)}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action
                  title="Launch Claude Terminal"
                  onAction={async () => {
                    try {
                      await showToast({
                        style: Toast.Style.Animated,
                        title: 'Launching Claude...',
                        message: `Opening terminal in ${instance.name}`,
                      });

                      const success = await launchClaudeTerminal(instance);

                      if (success) {
                        // Focus the VS Code window
                        await focusVSCodeInstance(instance.path);

                        await showToast({
                          style: Toast.Style.Success,
                          title: 'Claude terminal launched',
                          message: `Terminal created in ${instance.name}`,
                        });

                        // Close Raycast window
                        await closeMainWindow();
                      } else {
                        await showToast({
                          style: Toast.Style.Failure,
                          title: 'Failed to launch Claude terminal',
                          message: 'Redis connection unavailable',
                        });
                      }
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: 'Failed to launch Claude terminal',
                        message: error instanceof Error ? error.message : 'Unknown error',
                      });
                    }
                  }}
                  icon={Icon.Terminal}
                  shortcut={{ modifiers: ['cmd'], key: 'e' }}
                />
                {instance.prStatus && (
                  <Action.OpenInBrowser title="Open PR" url={instance.prStatus.url} icon={Icon.Globe} />
                )}
                {instance.caddyHost && (
                  <Action.OpenInBrowser
                    title="Open Dev Environment"
                    url={instance.caddyHost.url}
                    icon={Icon.Link}
                    shortcut={{ modifiers: ['cmd'], key: 'o' }}
                  />
                )}
                {getSpotlightUrl(instance) && (
                  <Action.OpenInBrowser
                    title="Open Spotlight"
                    url={getSpotlightUrl(instance)!}
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 's' }}
                  />
                )}

                <Action.OpenInBrowser
                  title="Open Queue Dashboard"
                  url={`http://localhost:9999?instance=${encodeURIComponent(instance.name)}`}
                  icon={Icon.List}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'q' }}
                />

                {instance.tmuxStatus?.exists && (
                  <>
                    <Action
                      title="View Tmux Logs"
                      onAction={async () => {
                        try {
                          const output = await getTmuxSessionOutput(instance.tmuxStatus!.name, 25);
                          await showToast({
                            style: Toast.Style.Success,
                            title: 'Tmux Session Output',
                            message: output.split('\n').slice(-3).join('\n'),
                          });
                        } catch (error) {
                          await showToast({
                            style: Toast.Style.Failure,
                            title: 'Failed to get tmux output',
                            message: error instanceof Error ? error.message : 'Unknown error',
                          });
                        }
                      }}
                      icon={Icon.Eye}
                      shortcut={{ modifiers: ['cmd'], key: 't' }}
                    />
                    <Action
                      title="Attach to Tmux Session"
                      onAction={async () => {
                        try {
                          await attachToTmuxSession(instance.tmuxStatus!.name);
                          await showToast({
                            style: Toast.Style.Success,
                            title: 'Opening tmux session',
                            message: `Attaching to ${instance.tmuxStatus!.name}`,
                          });
                        } catch (error) {
                          await showToast({
                            style: Toast.Style.Failure,
                            title: 'Failed to attach to tmux',
                            message: error instanceof Error ? error.message : 'Unknown error',
                          });
                        }
                      }}
                      icon={Icon.Terminal}
                      shortcut={{ modifiers: ['cmd', 'shift'], key: 't' }}
                    />
                  </>
                )}

                {instance.tmuxStatus && !instance.tmuxStatus.exists && (
                  <Action
                    title="Create Tmux Session"
                    onAction={async () => {
                      try {
                        await createTmuxSession(instance.tmuxStatus!.name, instance.path);
                        await showToast({
                          style: Toast.Style.Success,
                          title: 'Tmux session created',
                          message: `Created ${instance.tmuxStatus!.name}`,
                        });
                        // Refresh to show new session status
                        await loadInstances(true);
                      } catch (error) {
                        await showToast({
                          style: Toast.Style.Failure,
                          title: 'Failed to create tmux session',
                          message: error instanceof Error ? error.message : 'Unknown error',
                        });
                      }
                    }}
                    icon={Icon.Plus}
                    shortcut={{ modifiers: ['cmd'], key: 't' }}
                  />
                )}

                <Action
                  title="Start Dev Environment"
                  onAction={async () => {
                    try {
                      const sessionName = instance.tmuxStatus?.name ||
                        `${instance.name}${instance.gitInfo ? `-${instance.gitInfo.branch}` : ''}`;

                      // Check if session already exists
                      if (instance.tmuxStatus?.exists) {
                        await showToast({
                          style: Toast.Style.Success,
                          title: 'Dev environment already running',
                          message: `Session: ${sessionName}`,
                        });
                        return;
                      }

                      // Detect package manager
                      const packageManager = detectPackageManager(instance.path);
                      const command = `${packageManager} run dev`;

                      await showToast({
                        style: Toast.Style.Animated,
                        title: 'Starting dev environment...',
                        message: `Running ${command}`,
                      });

                      // Create tmux session with detected command
                      await createTmuxSession(sessionName, instance.path, command);

                      await showToast({
                        style: Toast.Style.Success,
                        title: 'Dev environment started',
                        message: `Session: ${sessionName}`,
                      });

                      // Refresh to show new session status
                      await loadInstances(true);
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: 'Failed to start dev environment',
                        message: error instanceof Error ? error.message : 'Unknown error',
                      });
                    }
                  }}
                  icon={Icon.Play}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'd' }}
                />

                <Action
                  title="Close VS Code & Tmux"
                  onAction={async () => {
                    try {
                      await showToast({
                        style: Toast.Style.Animated,
                        title: 'Closing...',
                        message: `Closing ${instance.name}`,
                      });

                      // Close tmux session if it exists
                      if (instance.tmuxStatus?.exists) {
                        try {
                          await killTmuxSession(instance.tmuxStatus.name);
                        } catch (error) {
                          console.error('Failed to kill tmux session:', error);
                          // Continue even if tmux fails
                        }
                      }

                      // Close VS Code window
                      await closeVSCodeInstance(instance.path);

                      // Wait a moment for processes to fully terminate
                      await new Promise(resolve => setTimeout(resolve, 1000));

                      // Trigger daemon refresh to update the list
                      await triggerDaemonRefresh();

                      await showToast({
                        style: Toast.Style.Success,
                        title: 'Closed successfully',
                        message: `Closed ${instance.name}`,
                      });
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: 'Failed to close',
                        message: error instanceof Error ? error.message : 'Unknown error',
                      });
                    }
                  }}
                  icon={Icon.XMarkCircle}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ['cmd'], key: 'w' }}
                />

                <Action.ShowInFinder path={instance.path} />
                <Action.CopyToClipboard title="Copy Path" content={instance.path} />
                <Action
                  title="Clear Cache & Refresh"
                  onAction={() => {
                    clearCache();
                    loadInstances(true);
                  }}
                  icon={Icon.Trash}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'r' }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

function getDetailMarkdown(instance: InstanceWithStatus): string {
  const sections: string[] = [];

  sections.push(`# 📁 ${instance.name}\n`);
  sections.push(`\`${instance.path}\`\n`);

  if (instance.gitInfo) {
    sections.push(`## Git Status\n`);

    // Branch info
    const branchInfo = instance.gitInfo.remoteBranch
      ? `${instance.gitInfo.branch} → ${instance.gitInfo.remoteBranch}`
      : instance.gitInfo.branch;
    sections.push(`- **Branch:** ⎇ ${branchInfo}`);

    // Working directory status
    if (instance.gitInfo.isDirty) {
      const statusParts: string[] = [];
      if (instance.gitInfo.staged > 0) {
        statusParts.push(`●${instance.gitInfo.staged} staged`);
      }
      if (instance.gitInfo.modified > 0) {
        statusParts.push(`±${instance.gitInfo.modified} modified`);
      }
      if (instance.gitInfo.untracked > 0) {
        statusParts.push(`?${instance.gitInfo.untracked} untracked`);
      }
      sections.push(`- **Working tree:** ${statusParts.join(', ')}`);
    } else {
      sections.push(`- **Working tree:** ✓ clean`);
    }

    // Remote sync status
    if (instance.gitInfo.remoteBranch) {
      const remoteParts: string[] = [];
      if (instance.gitInfo.ahead && instance.gitInfo.ahead > 0) {
        remoteParts.push(`↑${instance.gitInfo.ahead} ahead`);
      }
      if (instance.gitInfo.behind && instance.gitInfo.behind > 0) {
        remoteParts.push(`↓${instance.gitInfo.behind} behind`);
      }

      if (remoteParts.length > 0) {
        sections.push(`- **Remote sync:** ${remoteParts.join(', ')}`);
      } else if (instance.gitInfo.ahead === 0 && instance.gitInfo.behind === 0) {
        sections.push(`- **Remote sync:** ✓ up to date`);
      }
    }

    // Last commit
    if (instance.gitInfo.lastCommit) {
      sections.push(`- **Last commit:** ${instance.gitInfo.lastCommit.message}`);
      sections.push(`  - by ${instance.gitInfo.lastCommit.author} • ${instance.gitInfo.lastCommit.date}`);
    }

    sections.push('');
  }

  if (instance.prStatus) {
    sections.push(`## Pull Request\n`);
    sections.push(`**[#${instance.prStatus.number} ${instance.prStatus.title}](${instance.prStatus.url})**\n`);
    sections.push(`- **State:** ${instance.prStatus.state}`);
    sections.push(`- **Author:** ${instance.prStatus.author}`);

    if (instance.prStatus.mergeable) {
      const mergeText =
        instance.prStatus.mergeable === 'MERGEABLE'
          ? '✅ Ready to merge'
          : instance.prStatus.mergeable === 'CONFLICTING'
            ? '⚠️ Has merge conflicts'
            : '⏳ Calculating...';
      sections.push(`- **Mergeable:** ${mergeText}`);
    }
    sections.push('');

    if (instance.prStatus.checks) {
      const { passing, failing, pending, conclusion, runs, total } = instance.prStatus.checks;

      // Overall check status
      let checksStatus = '';
      if (conclusion === 'success') {
        checksStatus = `✅ All checks passing (${passing}/${total})`;
      } else if (conclusion === 'failure') {
        checksStatus = `❌ ${failing} checks failing`;
        if (passing > 0) {
          checksStatus += `, ${passing} passing`;
        }
        if (pending > 0) {
          checksStatus += `, ${pending} pending`;
        }
        checksStatus += ` (${total} total)`;
      } else if (conclusion === 'pending') {
        checksStatus = `🟡 ${pending} checks pending`;
        if (passing > 0) {
          checksStatus += `, ${passing} passing`;
        }
        if (failing > 0) {
          checksStatus += `, ${failing} failing`;
        }
        checksStatus += ` (${total} total)`;
      }

      sections.push(`### Checks\n`);
      sections.push(`${checksStatus}\n`);

      // Individual check details
      if (runs && runs.length > 0) {
        sections.push(`**Check details:**\n`);
        for (const run of runs) {
          let statusIcon = '○';

          if (run.bucket === 'pass') {
            statusIcon = '✅';
          } else if (run.bucket === 'fail' || run.bucket === 'cancel') {
            statusIcon = '❌';
          } else if (run.bucket === 'pending') {
            statusIcon = '🔄';
          } else if (run.bucket === 'skipping') {
            statusIcon = '⏭️';
          } else {
            // Fallback to state if bucket is unclear
            if (run.state === 'success') {
              statusIcon = '✅';
            } else if (run.state === 'failure') {
              statusIcon = '❌';
            } else {
              statusIcon = '⏳';
            }
          }

          sections.push(`- ${statusIcon} ${run.name}`);
        }
        sections.push('');
      }
    }
  }

  if (instance.claudeStatus) {
    const emoji = instance.claudeStatus.isWorking ? '🔥' : '💤';
    const status = instance.claudeStatus.isWorking ? 'Working' : 'Idle';
    sections.push(`## Claude Code ${emoji}\n`);
    sections.push(`- **Status:** ${status}`);
    sections.push(`- **PID:** ${instance.claudeStatus.pid}`);

    if (instance.claudeStatus.lastActivityTime) {
      const ageSeconds = Math.floor((Date.now() - getActivityTimestamp(instance.claudeStatus.lastActivityTime)) / 1000);
      const ageMinutes = Math.floor(ageSeconds / 60);
      const timeStr = ageMinutes > 0 ? `${ageMinutes} minute${ageMinutes > 1 ? 's' : ''} ago` : 'just now';
      sections.push(`- **Last Activity:** ${timeStr}`);
    }
    sections.push('');
  }

  if (instance.opencodeStatus?.active || instance.opencodeStatus?.opencodeFinished) {
    const sessions = instance.opencodeStatus.sessions;
    const sessionCount = sessions ? Object.keys(sessions).length : 0;
    
    // Show individual sessions if multiple
    if (sessions && sessionCount > 1) {
      sections.push(`## OpenCode (${sessionCount} instances)\n`);
      
      for (const [pidStr, session] of Object.entries(sessions)) {
        let emoji: string;
        if (session.status === 'working') {
          emoji = '🔥';
        } else if (session.status === 'waiting') {
          emoji = '⏳';
        } else if (session.status === 'idle') {
          emoji = '💤';
        } else {
          emoji = '❌';
        }
        
        const ageSeconds = session.lastActivity ? Math.floor((Date.now() - session.lastActivity) / 1000) : 0;
        const ageMinutes = Math.floor(ageSeconds / 60);
        const timeStr = ageMinutes > 0 ? `${ageMinutes}m ago` : 'now';
        
        sections.push(`### PID ${pidStr} ${emoji}`);
        sections.push(`- **Status:** ${session.status}`);
        sections.push(`- **Last Activity:** ${timeStr}`);
        
        if (session.metrics) {
          const { filesEdited, commandsRun } = session.metrics;
          if (filesEdited > 0 || commandsRun > 0) {
            sections.push(`- **Activity:** ${filesEdited} files, ${commandsRun} commands`);
          }
        }
        sections.push('');
      }
    } else {
      // Single session or legacy format
      const isFinished = instance.opencodeStatus.opencodeFinished;
      const isWorking = instance.opencodeStatus.isWorking;
      const isWaiting = instance.opencodeStatus.isWaiting;
      const isIdle = instance.opencodeStatus.isIdle;
      
      let emoji: string;
      let status: string;
      
      if (isFinished) {
        emoji = '✅';
        status = 'Finished';
      } else if (isWorking) {
        emoji = '🔥';
        status = 'Working';
      } else if (isWaiting) {
        emoji = '⏳';
        status = 'Waiting for input';
      } else if (isIdle) {
        emoji = '💤';
        status = 'Idle';
      } else {
        emoji = '🤖';
        status = 'Active';
      }
      
      sections.push(`## OpenCode ${emoji}\n`);
      sections.push(`- **Status:** ${status}`);
      if (instance.opencodeStatus.sessionId) {
        sections.push(`- **Session:** ${instance.opencodeStatus.sessionId.slice(0, 8)}...`);
      }

      if (instance.opencodeStatus.metrics) {
        const { filesEdited, commandsRun, toolsUsed } = instance.opencodeStatus.metrics;
        sections.push(`- **Files Edited:** ${filesEdited}`);
        sections.push(`- **Commands Run:** ${commandsRun}`);
        
        const toolsList = Object.entries(toolsUsed)
          .filter(([_, count]) => count > 0)
          .map(([tool, count]) => `${tool}: ${count}`)
          .join(', ');
        if (toolsList) {
          sections.push(`- **Tools Used:** ${toolsList}`);
        }
      }

      if (instance.opencodeStatus.lastEventTime) {
        const ageSeconds = Math.floor((Date.now() - instance.opencodeStatus.lastEventTime) / 1000);
        const ageMinutes = Math.floor(ageSeconds / 60);
        const timeStr = ageMinutes > 0 ? `${ageMinutes} minute${ageMinutes > 1 ? 's' : ''} ago` : 'just now';
        sections.push(`- **Last Activity:** ${timeStr}`);
      }
      sections.push('');
    }
  }

  if (instance.tmuxStatus) {
    const emoji = instance.tmuxStatus.exists ? '✅' : '⏸️';
    const status = instance.tmuxStatus.exists ? 'Active' : 'Not running';
    sections.push(`## Tmux Session ${emoji}\n`);
    sections.push(`- **Name:** ${instance.tmuxStatus.name}`);
    sections.push(`- **Status:** ${status}`);

    if (instance.tmuxStatus.exists) {
      sections.push(`\nUse **Cmd+T** to view logs or **Cmd+Shift+T** to attach`);
    } else {
      sections.push(`\nUse **Cmd+T** to create session`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
