import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
  open,
  LocalStorage,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { focusVSCodeInstance } from "./utils/vscode";
import { loadFromRedis } from "./utils/daemon-client";
import { getKanbanTasks, getCiStatusColor } from "./utils/kanban-client";
import { isPWAInstalled, launchPWAWithUrl } from "./utils/pwa";
import type { InstanceWithStatus, KanbanTaskInstance } from "./types";

// Storage key for remembering which section was last selected
const LAST_SECTION_KEY = "switch-instance-last-section";
type SectionType = "kanban" | "vscode";

// Storage for recently selected items (for sorting by recency)
const RECENT_ITEMS_KEY = "switch-instance-recent-items";
const MAX_RECENT_ITEMS = 20;

interface RecentItem {
  id: string; // taskId for kanban, path for vscode
  type: SectionType;
  timestamp: number;
}

async function getRecentItems(): Promise<RecentItem[]> {
  const stored = await LocalStorage.getItem<string>(RECENT_ITEMS_KEY);
  return stored ? JSON.parse(stored) : [];
}

async function addRecentItem(id: string, type: SectionType): Promise<void> {
  const recent = await getRecentItems();
  // Remove if already exists
  const filtered = recent.filter(
    (item) => !(item.id === id && item.type === type),
  );
  // Add to front
  filtered.unshift({ id, type, timestamp: Date.now() });
  // Keep only MAX_RECENT_ITEMS
  const trimmed = filtered.slice(0, MAX_RECENT_ITEMS);
  await LocalStorage.setItem(RECENT_ITEMS_KEY, JSON.stringify(trimmed));
}

export default function SwitchInstanceCommand() {
  const [vscodeInstances, setVscodeInstances] = useState<InstanceWithStatus[]>(
    [],
  );
  const [kanbanTasks, setKanbanTasks] = useState<KanbanTaskInstance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [preferredSection, setPreferredSection] =
    useState<SectionType>("kanban");
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    // Load the last selected section preference and recent items
    Promise.all([
      LocalStorage.getItem<SectionType>(LAST_SECTION_KEY),
      getRecentItems(),
    ]).then(([section, recent]) => {
      if (section) setPreferredSection(section);
      setRecentItems(recent);
    });
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);

    try {
      // Load VSCode instances and Kanban tasks in parallel
      const [redisCache, tasks] = await Promise.all([
        loadFromRedis(),
        getKanbanTasks(),
      ]);

      if (redisCache?.instances) {
        setVscodeInstances(redisCache.instances);
      }

      setKanbanTasks(tasks);
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
      // Remember that VSCode was selected, so it shows first next time
      await LocalStorage.setItem(LAST_SECTION_KEY, "vscode" as SectionType);
      // Track this item as recently used
      await addRecentItem(instance.path, "vscode");
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

  async function handleKanbanSelect(task: KanbanTaskInstance) {
    try {
      // Remember that Kanban was selected, so it shows first next time
      await LocalStorage.setItem(LAST_SECTION_KEY, "kanban" as SectionType);
      // Track this item as recently used
      await addRecentItem(task.taskId, "kanban");

      // Open the direct link in browser
      // directLink is a path like "/projects/{id}/tasks/{id}/attempts/latest"
      // baseUrl comes from the vibe-kanban instance (e.g., "http://localhost:3456")
      const baseUrl = task.baseUrl || "http://localhost:3456";
      const path =
        task.directLink ||
        `/projects/${task.projectId}/tasks/${task.taskId}/attempts/latest`;
      // Include devctl2Url as query param for preview to use (Caddy subdomain URL)
      const url = task.devctl2Url
        ? `${baseUrl}${path}?view=preview&devUrl=${encodeURIComponent(task.devctl2Url)}`
        : `${baseUrl}${path}?view=preview`;

      // Try to open in PWA first (focuses existing window if open)
      const pwaInstalled = await isPWAInstalled();
      if (pwaInstalled) {
        const opened = await launchPWAWithUrl(url);
        if (opened) {
          await closeMainWindow();
          return;
        }
      }

      // Fallback to default browser
      await open(url);
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to open task",
        message: String(error),
      });
    }
  }

  async function handleSwitchToVSCode(task: KanbanTaskInstance) {
    if (!task.repoPath) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No repository path",
        message: "This task has no associated repository",
      });
      return;
    }

    try {
      await focusVSCodeInstance(task.repoPath);
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch to VSCode",
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

  function getKanbanAccessories(
    task: KanbanTaskInstance,
  ): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    // Status
    accessories.push({
      tag: { value: task.status, color: getStatusColor(task.status) },
    });

    // PR info
    if (task.prInfo) {
      accessories.push({
        icon: { source: Icon.Link, tintColor: Color.Blue },
        text: `#${task.prInfo.number}`,
        tooltip: `PR: ${task.prInfo.url}`,
      });

      // CI status from prStatus
      if (task.prStatus?.checks) {
        const ciColor = getCiStatusColor(task);
        const ciIcon =
          ciColor === "Green"
            ? { source: Icon.CheckCircle, tintColor: Color.Green }
            : ciColor === "Red"
              ? { source: Icon.XMarkCircle, tintColor: Color.Red }
              : { source: Icon.Clock, tintColor: Color.Yellow };

        const checks = task.prStatus.checks;
        accessories.push({
          icon: ciIcon,
          tooltip: `CI: ${checks.passing} passing, ${checks.failing} failing, ${checks.pending} pending`,
        });
      }
    }

    // Project name
    accessories.push({
      text: task.projectName,
      tooltip: `Project: ${task.projectName}`,
    });

    return accessories;
  }

  function getStatusColor(status: string): Color {
    const statusLower = status.toLowerCase();
    if (statusLower.includes("done") || statusLower.includes("complete")) {
      return Color.Green;
    } else if (
      statusLower.includes("progress") ||
      statusLower.includes("review")
    ) {
      return Color.Blue;
    } else if (statusLower.includes("blocked")) {
      return Color.Red;
    }
    return Color.SecondaryText;
  }

  // Find matching VSCode instance for a kanban task
  function findMatchingVSCode(
    task: KanbanTaskInstance,
  ): InstanceWithStatus | undefined {
    if (!task.repoPath) return undefined;
    return vscodeInstances.find((i) => i.path === task.repoPath);
  }

  // Combine all items into a single list with type info
  type UnifiedItem =
    | { type: "kanban"; data: KanbanTaskInstance }
    | { type: "vscode"; data: InstanceWithStatus };

  const allItems: UnifiedItem[] = [
    ...kanbanTasks.map((task) => ({ type: "kanban" as const, data: task })),
    ...vscodeInstances.map((instance) => ({
      type: "vscode" as const,
      data: instance,
    })),
  ];

  // Build a map of recent items for fast lookup (id -> recency index)
  const recentMap = new Map(
    recentItems.map((item, index) => [`${item.type}-${item.id}`, index]),
  );

  // Sort: recently used first, then preferred type, then alphabetically
  allItems.sort((a, b) => {
    const aKey =
      a.type === "kanban"
        ? `kanban-${a.data.taskId}`
        : `vscode-${a.data.path}`;
    const bKey =
      b.type === "kanban"
        ? `kanban-${b.data.taskId}`
        : `vscode-${b.data.path}`;

    const aRecent = recentMap.get(aKey) ?? Infinity;
    const bRecent = recentMap.get(bKey) ?? Infinity;

    // Recently used items first
    if (aRecent !== bRecent) return aRecent - bRecent;

    // Then preferred type
    if (a.type === preferredSection && b.type !== preferredSection) return -1;
    if (b.type === preferredSection && a.type !== preferredSection) return 1;

    // Then alphabetically
    const aName = a.type === "kanban" ? a.data.title : a.data.name;
    const bName = b.type === "kanban" ? b.data.title : b.data.name;
    return aName.localeCompare(bName);
  });

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search instances and tasks..."
    >
      {allItems.map((item) => {
        if (item.type === "kanban") {
          const task = item.data;
          const matchingVSCode = findMatchingVSCode(task);
          return (
            <List.Item
              key={`kanban-${task.taskId}`}
              icon={{ source: Icon.Clipboard, tintColor: Color.Orange }}
              title={task.title}
              subtitle={task.branch}
              accessories={[
                { tag: { value: "Kanban", color: Color.Orange } },
                ...getKanbanAccessories(task),
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="Open in Vibe Kanban"
                    icon={Icon.Globe}
                    onAction={() => handleKanbanSelect(task)}
                  />
                  {matchingVSCode && (
                    <Action
                      title="Switch to VS Code"
                      icon={Icon.Window}
                      onAction={() => handleSwitchToVSCode(task)}
                      shortcut={{ modifiers: ["cmd"], key: "return" }}
                    />
                  )}
                  {task.prInfo?.url && (
                    <Action.OpenInBrowser
                      title="Open PR in Browser"
                      url={task.prInfo.url}
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
          );
        } else {
          const instance = item.data;
          return (
            <List.Item
              key={`vscode-${instance.path}`}
              icon={{ source: Icon.Window, tintColor: Color.Blue }}
              title={instance.name}
              subtitle={instance.path}
              accessories={[
                { tag: { value: "VS Code", color: Color.Blue } },
                ...getVSCodeAccessories(instance),
              ]}
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
          );
        }
      })}

      {/* Empty state */}
      {!isLoading && allItems.length === 0 && (
        <List.EmptyView
          icon={Icon.Desktop}
          title="No Instances Found"
          description="No VS Code windows or Kanban tasks are currently available"
        />
      )}
    </List>
  );
}
