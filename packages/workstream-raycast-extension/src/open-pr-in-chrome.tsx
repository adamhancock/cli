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

export default function OpenPRInChromeCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chromeWindows, setChromeWindows] = useState<ChromeWindow[]>([]);
  const [chromeProfile, setChromeProfile] = useState<string | undefined>();

  useEffect(() => {
    loadInstances();
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

  async function loadInstances() {
    setIsLoading(true);

    try {
      // Try daemon first (fastest)
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        // Filter to only instances with PRs
        const withPR = daemonCache.instances.filter((i) => i.prStatus);
        setInstances(sortByUsageHistory(withPR));
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

      // Filter to only instances with PRs
      const withPR = enriched.filter((i) => i.prStatus);
      setInstances(sortByUsageHistory(withPR));
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load PRs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
  }

  async function openPRInBrowser(instance: InstanceWithStatus) {
    if (!instance.prStatus) return;

    try {
      const url = instance.prStatus.url;

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
        title: 'Failed to open PR',
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

    return Icon.Link;
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
    // Show PR title as subtitle
    if (instance.prStatus) {
      return instance.prStatus.title;
    }
    return '';
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

    return accessories;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search PRs...">
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Link}
          title="No PRs found"
          description="No VS Code instances with open PRs detected"
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
                  title="Open PR in Chrome"
                  onAction={() => openPRInBrowser(instance)}
                  icon={Icon.Link}
                />
                <Action.OpenInBrowser
                  title="Open PR in Browser"
                  url={instance.prStatus!.url}
                  icon={Icon.Globe}
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
                <Action
                  title="Refresh"
                  onAction={loadInstances}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action.CopyToClipboard
                  title="Copy PR URL"
                  content={instance.prStatus!.url}
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
