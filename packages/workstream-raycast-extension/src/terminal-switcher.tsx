import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow } from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import Redis from 'ioredis';
import { loadFromDaemon, loadFromRedis, subscribeToUpdates, type DaemonCache } from './utils/daemon-client';
import { focusVSCodeInstance } from './utils/vscode';
import { recordUsage, getUsageHistory } from './utils/cache';
import type { InstanceWithStatus } from './types';

interface ZshTerminalState {
  terminalId: string;
  pid: number;
  vscodePid: number | null;
  workspace: string;
  cwd: string;
  currentCommand: string;
  shellType: string;
  timestamp: number;
}

interface EnrichedTerminal {
  name: string;
  pid: number;
  currentCommand: string;
  cwd: string;
  purpose: string;
  workspace: string;
  vscodePid: number;
  terminalId: string;
  isActive: boolean;
  lastActivity: number;
}

async function getZshTerminalStates(): Promise<ZshTerminalState[]> {
  const redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 3 });

  try {
    // Scan for all terminal keys
    const keys = await redis.keys('workstream:terminal:*');
    const states: ZshTerminalState[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        try {
          const state = JSON.parse(data) as ZshTerminalState;
          // Only include recent states (within last 60 seconds)
          if (Date.now() - state.timestamp * 1000 < 60000) {
            states.push(state);
          }
        } catch (e) {
          console.error(`Failed to parse terminal state for ${key}:`, e);
        }
      }
    }

    return states;
  } finally {
    await redis.quit();
  }
}

async function getTerminalsForInstance(instance: InstanceWithStatus): Promise<EnrichedTerminal[]> {
  if (!instance.extensionState || !instance.extensionState.terminals) {
    return [];
  }

  const { terminals, vscodePid } = instance.extensionState;
  const zshStates = await getZshTerminalStates();

  // Match terminals by PID
  const enriched: EnrichedTerminal[] = [];

  for (let i = 0; i < terminals.pids.length; i++) {
    const pid = terminals.pids[i];
    const name = terminals.names[i] || `Terminal ${i + 1}`;

    // Find matching zsh state - match by PID only since VSCode helper processes
    // can have different PIDs than the extension host
    const zshState = zshStates.find((s) => s.pid === pid);

    // Determine purpose from name
    let purpose = 'general';
    const nameLower = name.toLowerCase();
    if (nameLower.includes('dev') || nameLower.includes('serve')) purpose = 'dev-server';
    else if (nameLower.includes('test')) purpose = 'testing';
    else if (nameLower.includes('build') || nameLower.includes('watch')) purpose = 'build';

    enriched.push({
      name,
      pid,
      currentCommand: zshState?.currentCommand || '',
      cwd: zshState?.cwd || instance.path,
      purpose,
      workspace: instance.path,
      vscodePid,
      terminalId: zshState?.terminalId || `shell-${pid}`,
      isActive: false, // TODO: track active terminal
      lastActivity: zshState?.timestamp || 0,
    });
  }

  // Sort by last activity (most recent first)
  enriched.sort((a, b) => {
    // Active terminal always first
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    // Then by last activity timestamp (most recent first)
    if (a.lastActivity !== b.lastActivity) {
      return b.lastActivity - a.lastActivity;
    }
    // Finally by name for stable ordering
    return a.name.localeCompare(b.name);
  });

  return enriched;
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

function formatLastActivity(timestamp: number): string {
  if (!timestamp) return '';

  const seconds = Math.floor(Date.now() / 1000 - timestamp);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function switchToTerminal(terminal: EnrichedTerminal) {
  try {
    // 1. Focus VSCode window FIRST
    await focusVSCodeInstance(terminal.workspace);

    // 2. Record usage for this instance
    recordUsage(terminal.workspace);

    // 3. Wait for window focus to complete (critical!)
    await new Promise(resolve => setTimeout(resolve, 300));

    // 4. THEN send focus request to VSCode extension via Redis
    const redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 3 });

    try {
      const channel = `workstream:terminal:focus:${Buffer.from(terminal.workspace).toString('base64')}`;
      await redis.publish(
        channel,
        JSON.stringify({ terminalPid: terminal.pid })
      );

      // 5. Update terminal timestamp in Redis to reflect the switch
      try {
        const terminalKey = `workstream:terminal:${terminal.terminalId}`;
        const existingData = await redis.get(terminalKey);

        if (existingData) {
          const state = JSON.parse(existingData);
          state.timestamp = Math.floor(Date.now() / 1000);
          await redis.setex(terminalKey, 60, JSON.stringify(state));
        } else {
          // Terminal state doesn't exist yet (zsh hooks not active or just started)
          // Create minimal state for timestamp tracking
          const minimalState = {
            terminalId: terminal.terminalId,
            pid: terminal.pid,
            vscodePid: terminal.vscodePid,
            workspace: terminal.workspace,
            cwd: terminal.cwd,
            currentCommand: terminal.currentCommand,
            shellType: '/bin/zsh',
            timestamp: Math.floor(Date.now() / 1000)
          };
          await redis.setex(terminalKey, 60, JSON.stringify(minimalState));
        }
      } catch (updateError) {
        // Don't fail the whole operation if timestamp update fails
        console.error('[TerminalSwitcher] Failed to update terminal timestamp:', updateError);
      }
    } finally {
      await redis.quit();
    }

    await showToast({
      style: Toast.Style.Success,
      title: 'Switched to Terminal',
      message: `${terminal.name} - ${terminal.currentCommand || 'idle'}`,
    });

    await closeMainWindow();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to switch',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function TerminalSwitcher() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [terminals, setTerminals] = useState<Map<string, EnrichedTerminal[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Subscribe to real-time updates
  useEffect(() => {
    console.log('[TerminalSwitcher] Setting up real-time subscription...');

    const cleanup = subscribeToUpdates(
      async (updatedInstances) => {
        console.log('[TerminalSwitcher] Received real-time update');
        await updateInstancesAndTerminals(updatedInstances);
      },
      () => {
        console.log('[TerminalSwitcher] Subscription error, falling back to initial load');
        loadData();
      }
    );

    cleanupRef.current = cleanup;

    return () => {
      console.log('[TerminalSwitcher] Cleaning up subscription');
      cleanup();
    };
  }, []);

  async function updateInstancesAndTerminals(updatedInstances: InstanceWithStatus[]) {
    try {
      const filteredInstances = updatedInstances
        .filter((i) => i.extensionActive); // Only show instances with extension active

      // Sort by usage history (same as VSCode switcher)
      const sortedInstances = sortByUsageHistory(filteredInstances);

      setInstances(sortedInstances);

      // Load terminals for each instance
      const terminalMap = new Map<string, EnrichedTerminal[]>();

      for (const instance of sortedInstances) {
        const terms = await getTerminalsForInstance(instance);
        if (terms.length > 0) {
          terminalMap.set(instance.path, terms);
        }
      }

      setTerminals(terminalMap);

      // Smart navigation: auto-select focused instance if it has terminals
      // Only auto-select once on initial load, never again
      if (selectedInstance === null && !hasAutoSelected) {
        const focusedInstance = sortedInstances.find((i) => i.extensionState?.window?.focused);
        if (focusedInstance && terminalMap.get(focusedInstance.path)?.length) {
          // Skip to terminals for focused instance
          setSelectedInstance(focusedInstance.path);
          setHasAutoSelected(true);
        }
      }

      setIsLoading(false);
    } catch (error) {
      console.error('[TerminalSwitcher] Failed to update:', error);
    }
  }

  async function loadData() {
    setIsLoading(true);

    try {
      // Load instances from daemon/Redis
      let cache: DaemonCache | null;
      try {
        cache = await loadFromRedis();
      } catch {
        cache = await loadFromDaemon();
      }

      if (!cache) {
        await showToast({
          style: Toast.Style.Failure,
          title: 'Failed to load data',
          message: 'Cannot connect to daemon or Redis',
        });
        setIsLoading(false);
        return;
      }

      await updateInstancesAndTerminals(cache.instances);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load terminals',
        message: error instanceof Error ? error.message : String(error),
      });
      setIsLoading(false);
    }
  }

  const purposeEmoji = (purpose: string) => {
    switch (purpose) {
      case 'dev-server': return '🚀';
      case 'testing': return '🧪';
      case 'build': return '🔨';
      default: return '💻';
    }
  };

  const instanceName = (workspace: string) => {
    return workspace.split('/').pop() || workspace;
  };

  // Two-step flow: show instances first, then terminals
  if (!selectedInstance) {
    // Step 1: Show instance list
    const instancesWithTerminals = instances.filter((i) => (terminals.get(i.path)?.length || 0) > 0);

    return (
      <List
        isLoading={isLoading}
        searchBarPlaceholder="Search workspaces..."
      >
        {instancesWithTerminals.length === 0 && !isLoading && (
          <List.EmptyView
            title="No Active Terminals"
            description="Terminals will appear here when the VSCode extension is active and zsh hooks are configured"
            icon={Icon.Terminal}
          />
        )}

        {instancesWithTerminals.map((instance) => {
          const terminalCount = terminals.get(instance.path)?.length || 0;

          return (
            <List.Item
              key={instance.path}
              title={instance.name}
              subtitle={`${terminalCount} terminal${terminalCount !== 1 ? 's' : ''}`}
              icon={{ source: Icon.AppWindow, tintColor: Color.Blue }}
              accessories={[
                {
                  text: instance.gitInfo?.branch || '',
                  tooltip: instance.gitInfo?.branch ? `Branch: ${instance.gitInfo.branch}` : undefined,
                },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="View Terminals"
                    icon={Icon.ArrowRight}
                    onAction={() => setSelectedInstance(instance.path)}
                  />
                  <Action
                    title="Refresh"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ['cmd'], key: 'r' }}
                    onAction={loadData}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List>
    );
  }

  // Step 2: Show terminals for selected instance
  const displayTerminals = terminals.get(selectedInstance) || [];
  const selectedInstanceObj = instances.find((i) => i.path === selectedInstance);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search terminals..."
      navigationTitle={selectedInstanceObj?.name || 'Terminals'}
    >
      {displayTerminals.length === 0 && !isLoading && (
        <List.EmptyView
          title="No Terminals"
          description="No terminals found for this workspace"
          icon={Icon.Terminal}
        />
      )}

      {displayTerminals.map((terminal) => {
        const subtitle = terminal.currentCommand || 'No active command';
        const cwdRelative = terminal.cwd.replace(terminal.workspace, '.');

        return (
          <List.Item
            key={terminal.terminalId}
            title={terminal.name}
            subtitle={subtitle}
            icon={{
              source: Icon.Terminal,
              tintColor: terminal.currentCommand ? Color.Green : Color.SecondaryText,
            }}
            accessories={[
              {
                text: purposeEmoji(terminal.purpose),
                tooltip: `Purpose: ${terminal.purpose}`,
              },
              {
                text: cwdRelative !== '.' ? cwdRelative : '',
                tooltip: terminal.cwd,
              },
              {
                text: formatLastActivity(terminal.lastActivity),
                icon: { source: Icon.Clock, tintColor: Color.SecondaryText },
                tooltip: terminal.lastActivity
                  ? `Last active: ${new Date(terminal.lastActivity * 1000).toLocaleString()}`
                  : 'No activity recorded',
              },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Switch to Terminal"
                  icon={Icon.ArrowRight}
                  onAction={() => switchToTerminal(terminal)}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  onAction={loadData}
                />
                <Action.CopyToClipboard
                  title="Copy Terminal ID"
                  content={terminal.terminalId}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                <Action.CopyToClipboard
                  title="Copy Current Command"
                  content={terminal.currentCommand}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                />
                <Action
                  title="Back to Workspaces"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: ['cmd'], key: 'backspace' }}
                  onAction={() => setSelectedInstance(null)}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
