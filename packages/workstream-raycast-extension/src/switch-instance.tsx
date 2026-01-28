import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
  LocalStorage,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { focusVSCodeInstance } from "./utils/vscode";
import { loadFromRedis } from "./utils/daemon-client";
import type { InstanceWithStatus } from "./types";

// Storage for recently selected items (for sorting by recency)
const RECENT_ITEMS_KEY = "switch-instance-recent-items";
const MAX_RECENT_ITEMS = 20;

interface RecentItem {
  id: string; // path for vscode
  timestamp: number;
}

async function getRecentItems(): Promise<RecentItem[]> {
  const stored = await LocalStorage.getItem<string>(RECENT_ITEMS_KEY);
  return stored ? JSON.parse(stored) : [];
}

async function addRecentItem(id: string): Promise<void> {
  const recent = await getRecentItems();
  // Remove if already exists
  const filtered = recent.filter((item) => item.id !== id);
  // Add to front
  filtered.unshift({ id, timestamp: Date.now() });
  // Keep only MAX_RECENT_ITEMS
  const trimmed = filtered.slice(0, MAX_RECENT_ITEMS);
  await LocalStorage.setItem(RECENT_ITEMS_KEY, JSON.stringify(trimmed));
}

export default function SwitchInstanceCommand() {
  const [vscodeInstances, setVscodeInstances] = useState<InstanceWithStatus[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    getRecentItems().then((recent) => {
      setRecentItems(recent);
    });
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);

    try {
      const redisCache = await loadFromRedis();

      if (redisCache?.instances) {
        setVscodeInstances(redisCache.instances);
      }
    } catch (error) {
      console.error("Failed to load data:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load instances",
        message: String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleVSCodeSelect(instance: InstanceWithStatus) {
    try {
      // Track this item as recently used
      await addRecentItem(instance.path);
      await focusVSCodeInstance(instance.path);
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch",
        message: String(error),
      });
    }
  }

  function getVSCodeAccessories(
    instance: InstanceWithStatus,
  ): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    // Branch
    if (instance.branch) {
      accessories.push({
        icon: Icon.ArrowNe,
        text: instance.branch,
        tooltip: `Branch: ${instance.branch}`,
      });
    }

    // PR status
    if (instance.prStatus) {
      const prIcon =
        instance.prStatus.state === "MERGED"
          ? { source: Icon.CheckCircle, tintColor: Color.Purple }
          : instance.prStatus.state === "CLOSED"
            ? { source: Icon.XMarkCircle, tintColor: Color.Red }
            : { source: Icon.Circle, tintColor: Color.Green };

      accessories.push({
        icon: prIcon,
        text: `#${instance.prStatus.number}`,
        tooltip: `PR: ${instance.prStatus.title}`,
      });

      // CI status
      if (instance.prStatus.checks) {
        const ciIcon =
          instance.prStatus.checks.conclusion === "success"
            ? { source: Icon.CheckCircle, tintColor: Color.Green }
            : instance.prStatus.checks.conclusion === "failure"
              ? { source: Icon.XMarkCircle, tintColor: Color.Red }
              : { source: Icon.Clock, tintColor: Color.Yellow };

        accessories.push({
          icon: ciIcon,
          tooltip: `CI: ${instance.prStatus.checks.passing}/${instance.prStatus.checks.total} passing`,
        });
      }
    }

    // Claude status
    if (instance.claudeStatus?.active) {
      accessories.push({
        icon: instance.claudeStatus.isWorking
          ? { source: Icon.Bolt, tintColor: Color.Orange }
          : { source: Icon.Clock, tintColor: Color.Yellow },
        tooltip: instance.claudeStatus.isWorking
          ? "Claude working"
          : "Claude waiting",
      });
    }

    return accessories;
  }

  // Build a map of recent items for fast lookup (id -> recency index)
  const recentMap = new Map(
    recentItems.map((item, index) => [item.id, index]),
  );

  // Sort: recently used first, then alphabetically
  const sortedInstances = [...vscodeInstances].sort((a, b) => {
    const aRecent = recentMap.get(a.path) ?? Infinity;
    const bRecent = recentMap.get(b.path) ?? Infinity;

    // Recently used items first
    if (aRecent !== bRecent) return aRecent - bRecent;

    // Then alphabetically
    return a.name.localeCompare(b.name);
  });

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search instances...">
      {sortedInstances.map((instance) => (
        <List.Item
          key={instance.path}
          icon={{ source: Icon.Window, tintColor: Color.Blue }}
          title={instance.name}
          subtitle={instance.path}
          accessories={getVSCodeAccessories(instance)}
          actions={
            <ActionPanel>
              <Action
                title="Switch to Window"
                icon={Icon.Window}
                onAction={() => handleVSCodeSelect(instance)}
              />
              {instance.prStatus?.url && (
                <Action.OpenInBrowser
                  title="Open PR in Browser"
                  url={instance.prStatus.url}
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                />
              )}
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={loadData}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      ))}

      {/* Empty state */}
      {!isLoading && sortedInstances.length === 0 && (
        <List.EmptyView
          icon={Icon.Desktop}
          title="No Instances Found"
          description="No VS Code windows are currently available"
        />
      )}
    </List>
  );
}
