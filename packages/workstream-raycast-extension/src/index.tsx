import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow } from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import { getVSCodeInstances, focusVSCodeInstance } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getPRStatus } from './utils/github';
import { isClaudeCodeActive } from './utils/claude';
import { getCachedInstances, setCachedInstances, clearCache, recordUsage, getUsageHistory } from './utils/cache';
import { loadFromDaemon, triggerDaemonRefresh, subscribeToUpdates } from './utils/daemon-client';
import type { InstanceWithStatus } from './types';

export default function Command() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Initial load
  useEffect(() => {
    loadInstances();
  }, []);

  // Subscribe to real-time updates from daemon
  useEffect(() => {
    console.log('Setting up WebSocket subscription...');

    const cleanup = subscribeToUpdates(
      (updatedInstances) => {
        console.log('Received real-time update:', updatedInstances.length);
        setIsRealtimeMode(true);
        setInstances(sortByUsageHistory(updatedInstances));
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

  async function loadInstances(forceRefresh = false, includePR = false) {
    setIsLoading(true);

    // If force refresh, trigger daemon to refetch immediately
    if (forceRefresh) {
      const triggered = await triggerDaemonRefresh();
      if (triggered) {
        console.log('Triggered daemon refresh');
        // Wait a bit for daemon to update cache
        await new Promise(resolve => setTimeout(resolve, 500));
        // WebSocket will automatically update the UI, so we can return early
        if (isRealtimeMode) {
          setIsLoading(false);
          return;
        }
      }
    }

    // If we're in real-time mode and not forcing a refresh, let WebSocket handle updates
    if (isRealtimeMode && !forceRefresh && instances.length > 0) {
      console.log('Using real-time mode, skipping manual fetch');
      setIsLoading(false);
      return;
    }

    // Try to load from daemon first (fastest - ~10ms)
    if (!forceRefresh) {
      const daemonInstances = await loadFromDaemon();
      if (daemonInstances && daemonInstances.length > 0) {
        console.log('Using daemon cache:', daemonInstances.length);
        setInstances(sortByUsageHistory(daemonInstances));
        setIsLoading(false);
        return;
      }
    } else {
      // On force refresh, always try daemon first (it should have fresh data now)
      const daemonInstances = await loadFromDaemon();
      if (daemonInstances && daemonInstances.length > 0) {
        console.log('Using refreshed daemon cache:', daemonInstances.length);
        setInstances(sortByUsageHistory(daemonInstances));
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

  function getStatusIcon(instance: InstanceWithStatus): Icon {
    // Check PR state first
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
    // Check PR state first
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

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    if (instance.gitInfo) {
      parts.push(instance.gitInfo.branch);

      if (instance.gitInfo.ahead || instance.gitInfo.behind) {
        const syncInfo: string[] = [];
        if (instance.gitInfo.ahead) syncInfo.push(`↑${instance.gitInfo.ahead}`);
        if (instance.gitInfo.behind) syncInfo.push(`↓${instance.gitInfo.behind}`);
        parts.push(syncInfo.join(' '));
      }

      if (instance.gitInfo.isDirty) {
        parts.push('✱');
      }
    }

    if (instance.prStatus) {
      parts.push(`PR #${instance.prStatus.number}`);
    }

    return parts.join(' • ');
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    if (instance.claudeStatus?.active) {
      const isWaiting = instance.claudeStatus.isWaiting;
      const isWorking = instance.claudeStatus.isWorking;

      let statusText: string;
      let tooltip: string;
      let color: Color;

      if (isWaiting) {
        statusText = 'Waiting';
        tooltip = 'Claude Code: Waiting for your input ⏳';
        color = Color.Orange;
      } else if (isWorking) {
        statusText = 'Working';
        tooltip = 'Claude Code: Actively working 🔥';
        color = Color.Purple;
      } else {
        statusText = 'Idle';
        tooltip = 'Claude Code: Idle (no recent activity)';
        color = Color.SecondaryText;
      }

      accessories.push({
        text: statusText,
        icon: { source: Icon.Bolt, tintColor: color },
        tooltip,
      });
    }

    if (instance.prStatus?.checks) {
      const { passing, failing, pending, total } = instance.prStatus.checks;
      accessories.push({
        text: `${passing}/${total}`,
        tooltip: `Checks: ${passing} passing, ${failing} failing, ${pending} pending`,
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
          ? "Search VS Code instances... ⚡ Real-time"
          : "Search VS Code instances..."
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
            icon={{ source: getStatusIcon(instance), tintColor: getStatusColor(instance) }}
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
                              Math.floor((Date.now() - instance.claudeStatus.lastActivityTime.getTime()) / 1000) < 60
                                ? 'Just now'
                                : `${Math.floor((Date.now() - instance.claudeStatus.lastActivityTime.getTime()) / 60000)} min ago`
                            }
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
                {instance.prStatus && (
                  <Action.OpenInBrowser title="Open PR" url={instance.prStatus.url} icon={Icon.Globe} />
                )}
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
    sections.push(`- **Branch:** ${instance.gitInfo.branch}`);

    if (instance.gitInfo.remoteBranch) {
      sections.push(`- **Remote:** ${instance.gitInfo.remoteBranch}`);
    }

    if (instance.gitInfo.ahead || instance.gitInfo.behind) {
      sections.push(`- **Sync:** ↑${instance.gitInfo.ahead || 0} commits ahead, ↓${instance.gitInfo.behind || 0} commits behind`);
    }

    sections.push(`- **Status:** ${instance.gitInfo.isDirty ? '✱ Dirty' : '✓ Clean'}`);

    if (instance.gitInfo.isDirty) {
      sections.push(
        `- **Changes:** ${instance.gitInfo.modified} modified, ${instance.gitInfo.staged} staged, ${instance.gitInfo.untracked} untracked`
      );
    }

    sections.push('');
  }

  if (instance.prStatus) {
    sections.push(`## Pull Request\n`);
    sections.push(`**[#${instance.prStatus.number} ${instance.prStatus.title}](${instance.prStatus.url})**\n`);
    sections.push(`- **State:** ${instance.prStatus.state}`);
    sections.push(`- **Author:** ${instance.prStatus.author}\n`);

    if (instance.prStatus.checks) {
      const { passing, failing, pending, conclusion } = instance.prStatus.checks;
      const emoji =
        conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⏳';
      sections.push(`### Checks ${emoji}\n`);
      sections.push(`- ${passing} passing`);
      sections.push(`- ${failing} failing`);
      sections.push(`- ${pending} pending\n`);
    }
  }

  if (instance.claudeStatus) {
    const emoji = instance.claudeStatus.isWorking ? '🔥' : '💤';
    const status = instance.claudeStatus.isWorking ? 'Working' : 'Idle';
    sections.push(`## Claude Code ${emoji}\n`);
    sections.push(`- **Status:** ${status}`);
    sections.push(`- **PID:** ${instance.claudeStatus.pid}`);

    if (instance.claudeStatus.lastActivityTime) {
      const ageSeconds = Math.floor((Date.now() - instance.claudeStatus.lastActivityTime.getTime()) / 1000);
      const ageMinutes = Math.floor(ageSeconds / 60);
      const timeStr = ageMinutes > 0 ? `${ageMinutes} minute${ageMinutes > 1 ? 's' : ''} ago` : 'just now';
      sections.push(`- **Last Activity:** ${timeStr}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
