import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { getVSCodeInstances, focusVSCodeInstance } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getPRStatus } from './utils/github';
import { loadFromDaemon } from './utils/daemon-client';
import type { InstanceWithStatus } from './types';

export default function OpenDevEnvironmentCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadEnvironments();
  }, []);

  async function loadEnvironments() {
    setIsLoading(true);

    try {
      // Try daemon first (fastest)
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        // Filter to only instances with Caddy hosts
        const withCaddy = daemonCache.instances.filter((i) => i.caddyHost);
        setInstances(withCaddy);
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

      // Enrich with git and PR info
      const enriched = await Promise.all(
        basicInstances.map(async (instance) => {
          const enrichedInstance: InstanceWithStatus = { ...instance };

          try {
            if (instance.isGitRepo) {
              enrichedInstance.gitInfo = (await getGitInfo(instance.path)) || undefined;

              if (enrichedInstance.gitInfo) {
                enrichedInstance.prStatus =
                  (await getPRStatus(instance.path, enrichedInstance.gitInfo.branch)) || undefined;
              }
            }
          } catch (error) {
            enrichedInstance.error = error instanceof Error ? error.message : 'Unknown error';
          }

          return enrichedInstance;
        })
      );

      // Filter to only instances with Caddy hosts (from daemon)
      const withCaddy = enriched.filter((i) => i.caddyHost);
      setInstances(withCaddy);
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load dev environments',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
  }

  async function openInBrowser(instance: InstanceWithStatus) {
    if (!instance.caddyHost) return;

    try {
      // Open URL
      await Action.OpenInBrowser({ url: instance.caddyHost.url });

      // Close Raycast
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to open URL',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function openAndSwitchToVSCode(instance: InstanceWithStatus) {
    if (!instance.caddyHost) return;

    try {
      // Open in browser first
      await fetch(instance.caddyHost.url, { method: 'HEAD' }).catch(() => {
        // Ignore fetch errors, just trying to open the URL
      });

      // Open browser
      const url = instance.caddyHost.url;
      await new Promise((resolve) => {
        const script = `open "${url}"`;
        require('child_process').exec(script, resolve);
      });

      // Small delay to let browser start opening
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Switch to VS Code
      await focusVSCodeInstance(instance.path);

      // Close Raycast
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to open environment',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
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

    return Icon.Globe;
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

    return Color.Blue;
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    if (instance.caddyHost) {
      parts.push(instance.caddyHost.url);
    }

    if (instance.gitInfo) {
      parts.push(`⎇ ${instance.gitInfo.branch}`);

      if (instance.prStatus) {
        let prDisplay = `#${instance.prStatus.number}`;

        if (instance.prStatus.state === 'OPEN') {
          if (instance.prStatus.checks) {
            if (instance.prStatus.checks.conclusion === 'success') {
              prDisplay += ' ✅';
            } else if (instance.prStatus.checks.conclusion === 'failure') {
              prDisplay += ' ❌';
            } else if (instance.prStatus.checks.conclusion === 'pending') {
              prDisplay += ' 🟡';
            }
          }
        } else if (instance.prStatus.state === 'MERGED') {
          prDisplay += ' ✓';
        } else if (instance.prStatus.state === 'CLOSED') {
          prDisplay += ' ✗';
        }

        parts.push(prDisplay);
      }
    }

    return parts.join(' • ');
  }

  function getSpotlightUrl(instance: InstanceWithStatus): string | null {
    if (!instance.caddyHost) return null;

    // Extract hostname from URL (e.g., "https://branch.example.localhost" -> "branch.example.localhost")
    try {
      const url = new URL(instance.caddyHost.url);
      // Spotlight UI is on port 8888
      return `https://${url.hostname}:8888`;
    } catch {
      return null;
    }
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    if (instance.tmuxStatus?.exists) {
      accessories.push({
        icon: { source: Icon.Terminal, tintColor: Color.Green },
        tooltip: `tmux: ${instance.tmuxStatus.name}`,
      });
    }

    if (instance.caddyHost?.upstreams && instance.caddyHost.upstreams.length > 0) {
      accessories.push({
        text: instance.caddyHost.upstreams[0],
        tooltip: 'Backend upstream',
      });
    }

    if (instance.prStatus?.checks) {
      const { passing, total } = instance.prStatus.checks;
      accessories.push({
        text: `${passing}/${total}`,
        tooltip: `CI Checks`,
      });
    }

    return accessories;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search dev environments...">
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Globe}
          title="No dev environments found"
          description="No Caddy routes detected. Make sure Caddy is running and has worktree routes configured."
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
                <Action.OpenInBrowser
                  title="Open in Browser"
                  url={instance.caddyHost!.url}
                  icon={Icon.Globe}
                />
                {getSpotlightUrl(instance) && (
                  <Action.OpenInBrowser
                    title="Open Spotlight"
                    url={getSpotlightUrl(instance)!}
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 's' }}
                  />
                )}
                <Action
                  title="Open & Switch to VS Code"
                  onAction={() => openAndSwitchToVSCode(instance)}
                  icon={Icon.Window}
                  shortcut={{ modifiers: ['cmd'], key: 'o' }}
                />
                <Action
                  title="Switch to VS Code"
                  onAction={async () => {
                    await focusVSCodeInstance(instance.path);
                    await closeMainWindow();
                  }}
                  icon={Icon.Code}
                  shortcut={{ modifiers: ['cmd'], key: 's' }}
                />
                {instance.prStatus && (
                  <Action.OpenInBrowser
                    title="Open PR"
                    url={instance.prStatus.url}
                    icon={Icon.Link}
                    shortcut={{ modifiers: ['cmd'], key: 'p' }}
                  />
                )}
                <Action
                  title="Refresh"
                  onAction={loadEnvironments}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action.CopyToClipboard
                  title="Copy URL"
                  content={instance.caddyHost!.url}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                <Action.ShowInFinder path={instance.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
