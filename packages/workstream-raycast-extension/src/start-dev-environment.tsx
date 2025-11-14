import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow } from '@raycast/api';
import { useState, useEffect } from 'react';
import { getVSCodeInstances, focusVSCodeInstance } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { loadFromDaemon } from './utils/daemon-client';
import { getUsageHistory, recordUsage } from './utils/cache';
import { createTmuxSession, attachToTmuxSession, detectPackageManager } from './utils/tmux';
import type { InstanceWithStatus } from './types';

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

export default function StartDevEnvironmentCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadInstances();
  }, []);

  async function loadInstances() {
    setIsLoading(true);

    try {
      // Try daemon first (fastest)
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        setInstances(sortByUsageHistory(daemonCache.instances));
        setIsLoading(false);
        return;
      }

      // Fallback to direct fetch
      const basicInstances = await getVSCodeInstances();

      if (basicInstances.length === 0) {
        setInstances([]);
        setIsLoading(false);
        return;
      }

      // Enrich with git info
      const enriched = await Promise.all(
        basicInstances.map(async (instance) => {
          const enrichedInstance: InstanceWithStatus = { ...instance };

          try {
            if (instance.isGitRepo) {
              enrichedInstance.gitInfo = (await getGitInfo(instance.path)) || undefined;
            }
          } catch (error) {
            enrichedInstance.error = error instanceof Error ? error.message : 'Unknown error';
          }

          return enrichedInstance;
        })
      );

      setInstances(sortByUsageHistory(enriched));
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load VS Code instances',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
  }

  async function startDevEnvironment(instance: InstanceWithStatus) {
    try {
      const sessionName =
        instance.tmuxStatus?.name || `${instance.name}${instance.gitInfo ? `-${instance.gitInfo.branch}` : ''}`;

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

      // Record usage
      recordUsage(instance.path);

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
      await loadInstances();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to start dev environment',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function startAndAttach(instance: InstanceWithStatus) {
    try {
      const sessionName =
        instance.tmuxStatus?.name || `${instance.name}${instance.gitInfo ? `-${instance.gitInfo.branch}` : ''}`;

      // Record usage
      recordUsage(instance.path);

      // If session doesn't exist, create it first
      if (!instance.tmuxStatus?.exists) {
        const packageManager = detectPackageManager(instance.path);
        const command = `${packageManager} run dev`;

        await showToast({
          style: Toast.Style.Animated,
          title: 'Starting dev environment...',
          message: `Running ${command}`,
        });

        await createTmuxSession(sessionName, instance.path, command);
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for session to start
      }

      // Attach to the session
      await attachToTmuxSession(sessionName);
      await showToast({
        style: Toast.Style.Success,
        title: instance.tmuxStatus?.exists ? 'Attached to session' : 'Dev environment started',
        message: `Session: ${sessionName}`,
      });

      // Close Raycast
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to start/attach to dev environment',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  function getStatusIcon(instance: InstanceWithStatus): Icon {
    if (instance.tmuxStatus?.exists) {
      return Icon.CheckCircle;
    }
    return Icon.Circle;
  }

  function getStatusColor(instance: InstanceWithStatus): Color {
    if (instance.tmuxStatus?.exists) {
      return Color.Green;
    }
    return Color.SecondaryText;
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    if (instance.gitInfo) {
      parts.push(`⎇ ${instance.gitInfo.branch}`);
    }

    if (instance.tmuxStatus?.exists) {
      parts.push(`✓ ${instance.tmuxStatus.name}`);
    } else {
      const packageManager = detectPackageManager(instance.path);
      parts.push(`Ready to start (${packageManager})`);
    }

    return parts.join(' • ');
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    if (instance.tmuxStatus?.exists) {
      accessories.push({
        icon: { source: Icon.Terminal, tintColor: Color.Green },
        tooltip: `Running: ${instance.tmuxStatus.name}`,
      });
    } else {
      const packageManager = detectPackageManager(instance.path);
      accessories.push({
        text: packageManager,
        tooltip: `Will use: ${packageManager} run dev`,
      });
    }

    return accessories;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search VS Code instances...">
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
            actions={
              <ActionPanel>
                <Action
                  title={instance.tmuxStatus?.exists ? 'Already Running' : 'Start Dev Environment'}
                  onAction={() => startDevEnvironment(instance)}
                  icon={Icon.Play}
                />
                <Action
                  title={instance.tmuxStatus?.exists ? 'Attach to Terminal' : 'Start & Attach'}
                  onAction={() => startAndAttach(instance)}
                  icon={Icon.Terminal}
                  shortcut={{ modifiers: ['cmd'], key: 't' }}
                />
                <Action
                  title="Switch to VS Code"
                  onAction={async () => {
                    recordUsage(instance.path);
                    await focusVSCodeInstance(instance.path);
                    await closeMainWindow();
                  }}
                  icon={Icon.Window}
                  shortcut={{ modifiers: ['cmd'], key: 's' }}
                />
                <Action
                  title="Refresh"
                  onAction={loadInstances}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action.ShowInFinder path={instance.path} />
                <Action.CopyToClipboard title="Copy Path" content={instance.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
