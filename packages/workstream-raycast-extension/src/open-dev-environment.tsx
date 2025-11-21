import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
  getPreferenceValues,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { exec } from 'child_process';
import { getVSCodeInstances, focusVSCodeInstance } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getPRStatus } from './utils/github';
import { loadFromDaemon } from './utils/daemon-client';
import { getUsageHistory, recordUsage } from './utils/cache';
import {
  normalizeUrl,
  getChromeWindows,
  findChromeTab,
  switchToChromeTab,
  openNewChromeTab,
  resolveTargetChromeProfile,
  type ChromeWindow,
} from './utils/chrome';
import type { InstanceWithStatus } from './types';

interface Preferences {
  defaultRepoPath?: string;
  devDomain?: string;
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

export default function OpenDevEnvironmentCommand() {
  const preferences = getPreferenceValues<Preferences>();
  const devDomain = preferences.devDomain || 'localhost';
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chromeWindows, setChromeWindows] = useState<ChromeWindow[]>([]);
  const [chromeProfile, setChromeProfile] = useState<string | undefined>();

  useEffect(() => {
    loadEnvironments();
    loadChromeWindows();
    resolveProfile();
  }, []);

  async function resolveProfile() {
    try {
      const profile = await resolveTargetChromeProfile();
      setChromeProfile(profile);
    } catch (error) {
      console.error('Failed to resolve Chrome profile:', error);
      // Continue without profile - will use default behavior
    }
  }

  async function loadChromeWindows() {
    try {
      const windows = await getChromeWindows();
      setChromeWindows(windows);
    } catch (error) {
      console.error('Failed to load Chrome windows:', error);
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

  async function loadEnvironments() {
    setIsLoading(true);

    try {
      // Try daemon first (fastest)
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        // Filter to only instances with Caddy hosts
        const withCaddy = daemonCache.instances.filter((i) => i.caddyHost);
        setInstances(sortByUsageHistory(withCaddy));
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
      setInstances(sortByUsageHistory(withCaddy));
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
      const url = instance.caddyHost.url;

      // Record usage for sorting next time
      recordUsage(instance.path);

      // Check if Chrome tab already exists
      await showToast({
        style: Toast.Style.Animated,
        title: 'Checking Chrome tabs...',
      });

      const existingTab = await findChromeTab(url);

      if (existingTab) {
        // Switch to existing tab
        await switchToChromeTab(existingTab.windowId, existingTab.tabIndex, chromeProfile);
        await showToast({
          style: Toast.Style.Success,
          title: 'Switched to existing tab',
          message: url,
        });
      } else {
        // Open new tab
        await openNewChromeTab(url, chromeProfile);
        await showToast({
          style: Toast.Style.Success,
          title: 'Opened in new tab',
          message: url,
        });
      }

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
      // Record usage for sorting next time
      recordUsage(instance.path);

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
    if (!instance.gitInfo?.branch) return null;

    const branch = instance.gitInfo.branch;

    // Caddy routes can be nested - check for subroute handler
    const routes = (instance.caddyHost.routes || []) as any[];

    // Helper function to search for spotlight route recursively
    const findSpotlightRoute = (routeList: any[]): string | null => {
      for (const route of routeList) {
        // If this is a subroute, search its nested routes
        if (route.handler === 'subroute' && route.routes) {
          const result = findSpotlightRoute(route.routes);
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
                  const port = parts[1];
                  return `http://${branch}.${devDomain}:${port}/`;
                }
              }
            }
          }
        }
      }
      return null;
    };

    return findSpotlightRoute(routes);
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
    }

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
                <Action
                  title="Open in Browser"
                  onAction={() => openInBrowser(instance)}
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
                    recordUsage(instance.path);
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
