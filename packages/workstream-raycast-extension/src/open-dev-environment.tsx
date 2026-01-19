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
  open,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { focusVSCodeInstance } from './utils/vscode';
import { loadFromDaemon, loadFromRedis } from './utils/daemon-client';
import { getUsageHistory, recordUsage } from './utils/cache';
import { fetchCaddyConfig, extractHosts } from './utils/caddy';
import {
  normalizeUrl,
  getChromeWindows,
  findChromeTab,
  switchToChromeTab,
  openNewChromeTab,
  resolveTargetChromeProfile,
  type ChromeWindow,
} from './utils/chrome';
import type { InstanceWithStatus, CaddyHost } from './types';

interface Preferences {
  defaultRepoPath?: string;
  devDomain?: string;
}

// Combined type for display - Caddy host with optional VSCode instance data
interface DevEnvironment {
  caddyHost: CaddyHost;
  instance?: InstanceWithStatus; // VSCode instance if open for this path
}

export default function OpenDevEnvironmentCommand() {
  const preferences = getPreferenceValues<Preferences>();
  const devDomain = preferences.devDomain || 'localhost';
  const [environments, setEnvironments] = useState<DevEnvironment[]>([]);
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
      // Fetch ALL Caddy routes directly from API
      const caddyConfig = await fetchCaddyConfig();
      if (!caddyConfig) {
        await showToast({
          style: Toast.Style.Failure,
          title: 'Caddy not running',
          message: 'Could not connect to Caddy API',
        });
        setEnvironments([]);
        setIsLoading(false);
        return;
      }

      const allHosts = extractHosts(caddyConfig);
      // Build set of all hostnames for lookup
      const allHostNames = new Set(allHosts.map((h) => h.name));
      // Filter out API-only hosts - only if they end with -api AND a corresponding non-api host exists
      // e.g., filter "devctl2-api.localhost" if "devctl2.localhost" exists
      // but keep "branch-name-api.localhost" if "branch-name.localhost" doesn't exist
      const caddyHosts = allHosts.filter((host) => {
        // Check if hostname matches pattern: {name}-api.{domain}
        const match = host.name.match(/^(.+)-api\.(.+)$/);
        if (!match) return true; // Not an -api route, keep it
        const [, baseName, domain] = match;
        const nonApiHostname = `${baseName}.${domain}`;
        // Only filter out if the non-api version exists
        return !allHostNames.has(nonApiHostname);
      });
      if (caddyHosts.length === 0) {
        setEnvironments([]);
        setIsLoading(false);
        return;
      }

      // Try to get VSCode instances to match with Caddy hosts
      let instances: InstanceWithStatus[] = [];

      const daemonCache = await loadFromDaemon();
      if (daemonCache?.instances) {
        instances = daemonCache.instances;
      } else {
        const redisCache = await loadFromRedis();
        if (redisCache?.instances) {
          instances = redisCache.instances;
        }
      }

      // Create instance lookup by path
      const instanceByPath = new Map<string, InstanceWithStatus>();
      for (const instance of instances) {
        const normalizedPath = instance.path.replace(/\/$/, '');
        instanceByPath.set(normalizedPath, instance);
      }

      // Combine Caddy hosts with matching VSCode instances
      const envs: DevEnvironment[] = caddyHosts.map((host) => {
        const normalizedPath = host.worktreePath?.replace(/\/$/, '');
        const matchingInstance = normalizedPath ? instanceByPath.get(normalizedPath) : undefined;
        return {
          caddyHost: host,
          instance: matchingInstance,
        };
      });

      // Sort by usage history (using worktree path)
      const usageHistory = getUsageHistory();
      envs.sort((a, b) => {
        const aPath = a.caddyHost.worktreePath || a.caddyHost.name;
        const bPath = b.caddyHost.worktreePath || b.caddyHost.name;
        const aTime = usageHistory[aPath] || 0;
        const bTime = usageHistory[bPath] || 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.caddyHost.name.localeCompare(b.caddyHost.name);
      });

      setEnvironments(envs);
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load dev environments',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setEnvironments([]);
      setIsLoading(false);
    }
  }

  async function openInBrowserForEnv(env: DevEnvironment) {
    try {
      const url = env.caddyHost.url;

      // Record usage for sorting next time
      recordUsage(env.caddyHost.worktreePath || env.caddyHost.name);

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

  async function openAndSwitchToVSCodeForEnv(env: DevEnvironment) {
    if (!env.instance) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'No VS Code window',
        message: 'Open this path in VS Code first',
      });
      return;
    }

    try {
      // Record usage for sorting next time
      recordUsage(env.caddyHost.worktreePath || env.caddyHost.name);

      // Open in browser using Raycast's open function
      await open(env.caddyHost.url);

      // Small delay to let browser start opening
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Switch to VS Code
      await focusVSCodeInstance(env.instance.path);

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

  function getStatusIcon(env: DevEnvironment): Icon {
    const instance = env.instance;
    // Check PR state first
    if (instance?.prStatus?.state === 'MERGED') {
      return Icon.CheckCircle;
    }
    if (instance?.prStatus?.state === 'CLOSED') {
      return Icon.XMarkCircle;
    }

    // Then check CI status for open PRs
    if (instance?.prStatus?.checks) {
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

  function getStatusColor(env: DevEnvironment): Color {
    const instance = env.instance;
    // Check PR state first
    if (instance?.prStatus?.state === 'MERGED') {
      return Color.Purple;
    }
    if (instance?.prStatus?.state === 'CLOSED') {
      return Color.SecondaryText;
    }

    // Then check CI status for open PRs
    if (instance?.prStatus?.checks) {
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

  function getSubtitle(env: DevEnvironment): string {
    const parts: string[] = [];

    parts.push(env.caddyHost.url);

    if (env.instance?.gitInfo) {
      parts.push(`⎇ ${env.instance.gitInfo.branch}`);

      if (env.instance.prStatus) {
        let prDisplay = `#${env.instance.prStatus.number}`;

        if (env.instance.prStatus.state === 'OPEN') {
          if (env.instance.prStatus.checks) {
            if (env.instance.prStatus.checks.conclusion === 'success') {
              prDisplay += ' ✅';
            } else if (env.instance.prStatus.checks.conclusion === 'failure') {
              prDisplay += ' ❌';
            } else if (env.instance.prStatus.checks.conclusion === 'pending') {
              prDisplay += ' 🟡';
            }
          }
        } else if (env.instance.prStatus.state === 'MERGED') {
          prDisplay += ' ✓';
        } else if (env.instance.prStatus.state === 'CLOSED') {
          prDisplay += ' ✗';
        }

        parts.push(prDisplay);
      }
    }

    return parts.join(' • ');
  }

  function getSpotlightUrl(env: DevEnvironment): string | null {
    const branch = env.instance?.gitInfo?.branch;
    if (!branch) return null;

    // Caddy routes can be nested - check for subroute handler
    const routes = (env.caddyHost.routes || []) as any[];

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

  function getAccessories(env: DevEnvironment): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];
    const instance = env.instance;

    // Show if VSCode is open for this path
    if (!instance) {
      accessories.push({
        icon: { source: Icon.XMarkCircle, tintColor: Color.SecondaryText },
        tooltip: 'No VS Code window open',
      });
    }

    // PR status section
    if (instance?.prStatus) {
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

    if (instance?.tmuxStatus?.exists) {
      accessories.push({
        icon: { source: Icon.Terminal, tintColor: Color.Green },
        tooltip: `tmux: ${instance.tmuxStatus.name}`,
      });
    }

    if (env.caddyHost.upstreams && env.caddyHost.upstreams.length > 0) {
      accessories.push({
        text: env.caddyHost.upstreams[0],
        tooltip: 'Backend upstream',
      });
    }

    return accessories;
  }

  // Get display name from Caddy host or worktree path
  function getDisplayName(env: DevEnvironment): string {
    if (env.instance?.name) {
      return env.instance.name;
    }
    // Extract name from worktree path or hostname
    if (env.caddyHost.worktreePath) {
      return env.caddyHost.worktreePath.split('/').pop() || env.caddyHost.name;
    }
    return env.caddyHost.name;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search dev environments...">
      {environments.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Globe}
          title="No dev environments found"
          description="No Caddy routes detected. Make sure Caddy is running and has routes configured."
        />
      ) : (
        environments.map((env) => (
          <List.Item
            key={env.caddyHost.name}
            icon={{ source: getStatusIcon(env), tintColor: getStatusColor(env) }}
            title={getDisplayName(env)}
            subtitle={getSubtitle(env)}
            accessories={getAccessories(env)}
            actions={
              <ActionPanel>
                <Action
                  title="Open in Browser"
                  onAction={() => openInBrowserForEnv(env)}
                  icon={Icon.Globe}
                />
                {getSpotlightUrl(env) && (
                  <Action.OpenInBrowser
                    title="Open Spotlight"
                    url={getSpotlightUrl(env)!}
                    icon={Icon.Eye}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 's' }}
                  />
                )}
                {env.instance && (
                  <Action
                    title="Open & Switch to VS Code"
                    onAction={() => openAndSwitchToVSCodeForEnv(env)}
                    icon={Icon.Window}
                    shortcut={{ modifiers: ['cmd'], key: 'o' }}
                  />
                )}
                {env.instance && (
                  <Action
                    title="Switch to VS Code"
                    onAction={async () => {
                      recordUsage(env.caddyHost.worktreePath || env.caddyHost.name);
                      await focusVSCodeInstance(env.instance!.path);
                      await closeMainWindow();
                    }}
                    icon={Icon.Code}
                    shortcut={{ modifiers: ['cmd'], key: 's' }}
                  />
                )}
                {env.instance?.prStatus && (
                  <Action.OpenInBrowser
                    title="Open PR"
                    url={env.instance.prStatus.url}
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
                  content={env.caddyHost.url}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                {env.caddyHost.worktreePath && (
                  <Action.ShowInFinder path={env.caddyHost.worktreePath} />
                )}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
