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
import { loadFromDaemon, loadFromRedis } from './utils/daemon-client';
import { getUsageHistory, recordUsage } from './utils/cache';
import { findChromeTab, switchToChromeTab, openNewChromeTab, normalizeUrl, getChromeWindows, type ChromeWindow } from './utils/chrome';
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

export default function OpenSpotlightEnvironmentCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chromeWindows, setChromeWindows] = useState<ChromeWindow[]>([]);

  useEffect(() => {
    loadEnvironments();
    loadChromeWindows();
  }, []);

  async function loadChromeWindows() {
    try {
      const windows = await getChromeWindows();
      setChromeWindows(windows);
    } catch (error) {
      console.error('Failed to load Chrome windows:', error);
    }
  }

  function isSpotlightOpenInChrome(instance: InstanceWithStatus): boolean {
    const spotlightUrl = getSpotlightUrl(instance);
    if (!spotlightUrl) return false;

    const normalizedTarget = normalizeUrl(spotlightUrl);

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
      // Try Redis first
      const redisCache = await loadFromRedis();
      if (redisCache) {
        const withSpotlight = redisCache.instances.filter((i) => getSpotlightUrl(i) !== null);
        setInstances(sortByUsageHistory(withSpotlight));
        setIsLoading(false);
        return;
      }

      // Fallback to daemon file cache
      const daemonCache = await loadFromDaemon();
      if (daemonCache) {
        const withSpotlight = daemonCache.instances.filter((i) => getSpotlightUrl(i) !== null);
        setInstances(sortByUsageHistory(withSpotlight));
        setIsLoading(false);
        return;
      }

      setInstances([]);
      setIsLoading(false);
    } catch (error) {
      console.error('Failed to load instances:', error);
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load spotlight environments',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
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
                  return `http://${branch}.assurix.localhost:${port}/`;
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

  async function openSpotlight(instance: InstanceWithStatus) {
    try {
      // Record usage for sorting next time
      recordUsage(instance.path);

      const spotlightUrl = getSpotlightUrl(instance);
      if (!spotlightUrl) {
        await showToast({
          style: Toast.Style.Failure,
          title: 'No spotlight environment',
          message: `${instance.name} does not have a spotlight environment`,
        });
        return;
      }

      // Check if Chrome tab exists
      await showToast({
        style: Toast.Style.Animated,
        title: 'Checking Chrome tabs...',
      });

      const existingTab = await findChromeTab(spotlightUrl);

      // Open or switch to tab
      if (existingTab) {
        await switchToChromeTab(existingTab.windowId, existingTab.tabIndex);
        await showToast({
          style: Toast.Style.Success,
          title: 'Switched to existing tab',
          message: spotlightUrl,
        });
      } else {
        await openNewChromeTab(spotlightUrl);
        await showToast({
          style: Toast.Style.Success,
          title: 'Opened in new tab',
          message: spotlightUrl,
        });
      }

      // Close Raycast
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to open spotlight',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    // Only show branch if it differs from instance name
    if (instance.gitInfo?.branch && instance.gitInfo.branch !== instance.name) {
      parts.push(instance.gitInfo.branch);
    }

    // Add concise PR info
    if (instance.prStatus) {
      let prDisplay = `#${instance.prStatus.number}`;

      // Add simple status indicator
      if (instance.prStatus.state === 'MERGED') {
        prDisplay += ' ✓';
      } else if (instance.prStatus.state === 'CLOSED') {
        prDisplay += ' ✗';
      } else if (instance.prStatus.checks) {
        // Just show check status for open PRs
        const { conclusion } = instance.prStatus.checks;
        if (conclusion === 'success') {
          prDisplay += ' ✓';
        } else if (conclusion === 'failure') {
          prDisplay += ' ✗';
        } else {
          prDisplay += ' ⏳';
        }
      }

      parts.push(prDisplay);
    }

    // Just show port instead of full URL
    const spotlightUrl = getSpotlightUrl(instance);
    if (spotlightUrl) {
      try {
        const url = new URL(spotlightUrl);
        parts.push(`:${url.port}`);
      } catch {
        // Ignore parse errors
      }
    }

    return parts.join(' • ');
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    // Chrome tab indicator - show if spotlight is open in Chrome
    if (isSpotlightOpenInChrome(instance)) {
      accessories.push({
        icon: { source: Icon.Globe, tintColor: Color.Blue },
        tooltip: 'Spotlight open in Chrome',
      });
    }

    // Spotlight status - online/offline indicator and event counts
    if (instance.spotlightStatus) {
      const { isOnline, errorCount, traceCount, logCount, port } = instance.spotlightStatus;

      // Online/offline status indicator
      accessories.push({
        icon: {
          source: Icon.CircleFilled,
          tintColor: isOnline ? Color.Green : Color.Red,
        },
        tooltip: isOnline ? `Spotlight online (port ${port})` : `Spotlight offline (port ${port})`,
      });

      // Event counts - only show if online and has events
      if (isOnline && (errorCount > 0 || traceCount > 0 || logCount > 0)) {
        // Errors
        if (errorCount > 0) {
          accessories.push({
            text: `E:${errorCount}`,
            icon: { source: Icon.XMarkCircle, tintColor: Color.Red },
            tooltip: `${errorCount} error${errorCount !== 1 ? 's' : ''}`,
          });
        }

        // Traces
        if (traceCount > 0) {
          accessories.push({
            text: `T:${traceCount}`,
            icon: { source: Icon.Link, tintColor: Color.Blue },
            tooltip: `${traceCount} trace${traceCount !== 1 ? 's' : ''}`,
          });
        }

        // Logs
        if (logCount > 0) {
          accessories.push({
            text: `L:${logCount}`,
            icon: { source: Icon.Document, tintColor: Color.SecondaryText },
            tooltip: `${logCount} log${logCount !== 1 ? 's' : ''}`,
          });
        }
      }
    }

    return accessories;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search spotlight environments...">
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Window}
          title="No spotlight environments found"
          description="Spotlight environments need a Caddy route with /_spotlight path"
        />
      ) : (
        instances.map((instance) => (
          <List.Item
            key={instance.path}
            title={instance.name}
            subtitle={getSubtitle(instance)}
            accessories={getAccessories(instance)}
            icon={{ source: Icon.Eye, tintColor: Color.Blue }}
            actions={
              <ActionPanel>
                <Action
                  title="Open Spotlight in Chrome"
                  icon={Icon.Globe}
                  onAction={() => openSpotlight(instance)}
                />
                <Action.CopyToClipboard
                  title="Copy Spotlight URL"
                  content={getSpotlightUrl(instance) || ''}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                {instance.prStatus && (
                  <Action.OpenInBrowser
                    title="Open PR in Browser"
                    url={instance.prStatus.url}
                    shortcut={{ modifiers: ['cmd'], key: 'p' }}
                  />
                )}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
