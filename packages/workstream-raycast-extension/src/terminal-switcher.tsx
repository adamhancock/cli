import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow, Form, useNavigation } from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import Redis from 'ioredis';
import { loadFromDaemon, loadFromRedis, subscribeToUpdates, type DaemonCache } from './utils/daemon-client';
import { focusVSCodeInstance, createNewTerminal } from './utils/vscode';
import { recordUsage, getUsageHistory } from './utils/cache';
import type { InstanceWithStatus, ClaudeSession } from './types';

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
  alias?: string; // Custom user-defined alias
  pid: number;
  currentCommand: string;
  cwd: string;
  purpose: string;
  workspace: string;
  vscodePid: number;
  terminalId: string;
  isActive: boolean;
  lastActivity: number;
  hasClaude?: boolean; // True if Claude is running in this terminal
  claudeWorking?: boolean; // True if Claude is actively working
  claudeWaiting?: boolean; // True if Claude is waiting for input
  claudeIdle?: boolean; // True if Claude is idle (not working, not waiting)
  claudeFinished?: boolean; // True if Claude finished
  claudeFinishedAt?: number; // Timestamp when Claude finished
}

async function getTerminalAlias(terminalId: string): Promise<string | null> {
  const redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 3 });

  try {
    const alias = await redis.get(`workstream:terminal:alias:${terminalId}`);
    return alias;
  } finally {
    await redis.quit();
  }
}

async function setTerminalAlias(terminalId: string, alias: string): Promise<void> {
  const redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 3 });

  try {
    if (alias.trim()) {
      // Set alias with no expiration
      await redis.set(`workstream:terminal:alias:${terminalId}`, alias.trim());
    } else {
      // Delete alias if empty
      await redis.del(`workstream:terminal:alias:${terminalId}`);
    }
  } finally {
    await redis.quit();
  }
}

async function getZshTerminalStates(): Promise<ZshTerminalState[]> {
  const redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 3 });

  try {
    // Scan for all terminal keys
    const keys = await redis.keys('workstream:terminal:*');
    const states: ZshTerminalState[] = [];

    for (const key of keys) {
      // Skip alias keys
      if (key.includes(':alias:')) continue;

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

  // Get Claude sessions info if available
  const claudeSessions = instance.claudeStatus?.sessions || {};

  // Helper to find Claude session for a terminal
  const findClaudeSession = (terminalPid: number, zshPid?: number, terminalId?: string): ClaudeSession | null => {
    // Check all sessions to see if any match this terminal
    for (const [sessionPid, session] of Object.entries(claudeSessions) as [string, ClaudeSession][]) {
      const pid = parseInt(sessionPid, 10);

      // Match by:
      // 1. Terminal ID (most reliable)
      // 2. Process PID matches Claude PID
      // 3. Zsh shell PID matches Claude PID
      // 4. Terminal PID matches session's terminal PID
      if (
        (terminalId && session.terminalId && terminalId === session.terminalId) ||
        terminalPid === pid ||
        (zshPid && zshPid === pid) ||
        (session.terminalPid && terminalPid === session.terminalPid)
      ) {
        return session;
      }
    }
    return null;
  };

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

    const terminalId = zshState?.terminalId || `shell-${pid}`;

    // Find Claude session for this terminal
    const claudeSession = findClaudeSession(pid, zshState?.pid, terminalId);

    // Load custom alias for this terminal
    const alias = await getTerminalAlias(terminalId);

    enriched.push({
      name,
      alias: alias || undefined,
      pid,
      currentCommand: zshState?.currentCommand || '',
      cwd: zshState?.cwd || instance.path,
      purpose,
      workspace: instance.path,
      vscodePid,
      terminalId,
      isActive: false, // TODO: track active terminal
      lastActivity: zshState?.timestamp || 0,
      hasClaude: !!claudeSession,
      claudeWorking: claudeSession?.status === 'working',
      claudeWaiting: claudeSession?.status === 'waiting',
      claudeIdle: claudeSession?.status === 'idle',
      claudeFinished: claudeSession?.status === 'finished',
      claudeFinishedAt: claudeSession?.finishedAt,
    });
  }

  // Return terminals in VSCode's order (no custom sorting)
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

function SetTerminalAliasForm({ terminal, onAliasSet }: { terminal: EnrichedTerminal; onAliasSet: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { alias: string }) {
    try {
      await setTerminalAlias(terminal.terminalId, values.alias);
      await showToast({
        style: Toast.Style.Success,
        title: values.alias ? 'Alias set' : 'Alias removed',
        message: values.alias ? `Terminal renamed to "${values.alias}"` : `Removed alias for ${terminal.name}`,
      });
      pop();
      onAliasSet();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to set alias',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Alias" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="alias"
        title="Terminal Alias"
        placeholder="Enter a friendly name for this terminal"
        defaultValue={terminal.alias || ''}
      />
      <Form.Description text={`Set a custom name for "${terminal.alias || terminal.name}". Leave empty to remove the alias.`} />
    </Form>
  );
}

async function switchToTerminal(terminal: EnrichedTerminal, fromLevel1: boolean = false) {
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
      // Skip update if already at level 1 (viewing terminal list) to avoid unnecessary updates
      if (!fromLevel1) {
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
  const [userNavigatedBack, setUserNavigatedBack] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Use refs to avoid stale closures in subscription callback
  const hasAutoSelectedRef = useRef(false);
  const userNavigatedBackRef = useRef(false);
  const selectedInstanceRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    selectedInstanceRef.current = selectedInstance;
  }, [selectedInstance]);

  useEffect(() => {
    hasAutoSelectedRef.current = hasAutoSelected;
  }, [hasAutoSelected]);

  useEffect(() => {
    userNavigatedBackRef.current = userNavigatedBack;
  }, [userNavigatedBack]);

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
      // Only auto-select once on initial load, and never after user manually navigates back
      // Use refs to avoid stale closures in subscription callback
      if (selectedInstanceRef.current === null && !hasAutoSelectedRef.current && !userNavigatedBackRef.current) {
        const focusedInstance = sortedInstances.find((i) => i.extensionState?.window?.focused);
        if (focusedInstance && terminalMap.get(focusedInstance.path)?.length) {
          // Skip to terminals for focused instance
          setSelectedInstance(focusedInstance.path);
          selectedInstanceRef.current = focusedInstance.path;
          setHasAutoSelected(true);
          hasAutoSelectedRef.current = true;
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
                    onAction={() => {
                      setSelectedInstance(instance.path);
                      selectedInstanceRef.current = instance.path;
                    }}
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
          actions={
            <ActionPanel>
              <Action
                title="Create New Terminal"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                onAction={async () => {
                  if (!selectedInstanceObj) return;
                  const success = await createNewTerminal(selectedInstanceObj, '', '');
                  if (success) {
                    await focusVSCodeInstance(selectedInstanceObj.path);
                    await showToast({
                      style: Toast.Style.Success,
                      title: 'Terminal Created',
                      message: `New terminal opened in ${selectedInstanceObj.name}`,
                    });
                    // Refresh to show the new terminal
                    setTimeout(() => loadData(), 500);
                  } else {
                    await showToast({
                      style: Toast.Style.Failure,
                      title: 'Failed to create terminal',
                      message: 'Redis connection unavailable',
                    });
                  }
                }}
              />
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={loadData}
              />
              <Action
                title="Back to Workspaces"
                icon={Icon.ArrowLeft}
                shortcut={{ modifiers: ['cmd'], key: 'backspace' }}
                onAction={() => {
                  setSelectedInstance(null);
                  selectedInstanceRef.current = null;
                  setUserNavigatedBack(true);
                  userNavigatedBackRef.current = true;
                }}
              />
            </ActionPanel>
          }
        />
      )}

      {displayTerminals.map((terminal) => {
        const cwdRelative = terminal.cwd.replace(terminal.workspace, '.');
        // Build subtitle: show command, or directory, or last activity
        let subtitle = terminal.currentCommand;
        if (!subtitle && cwdRelative !== '.') {
          subtitle = cwdRelative;
        } else if (!subtitle) {
          subtitle = terminal.lastActivity
            ? `Last active ${formatLastActivity(terminal.lastActivity)}`
            : 'No recent activity';
        }

        // Build accessories array with Claude status if applicable
        const accessories = [];

        // Claude status (if this terminal has Claude)
        if (terminal.hasClaude) {
          if (terminal.claudeWorking) {
            accessories.push({
              tag: { value: 'Claude Working', color: Color.Blue },
              tooltip: 'Claude is actively working in this terminal',
            });
          } else if (terminal.claudeWaiting) {
            accessories.push({
              tag: { value: 'Claude Waiting', color: Color.Orange },
              tooltip: 'Claude is waiting for your input',
            });
          } else if (terminal.claudeIdle) {
            accessories.push({
              tag: { value: 'Claude Idle', color: Color.SecondaryText },
              tooltip: 'Claude process exists but is not actively working',
            });
          } else if (terminal.claudeFinished && terminal.claudeFinishedAt) {
            const elapsed = Math.floor((Date.now() - terminal.claudeFinishedAt) / 1000);
            const timeAgo = formatLastActivity(Math.floor(terminal.claudeFinishedAt / 1000));
            accessories.push({
              tag: { value: `Claude Finished ${timeAgo}`, color: Color.Green },
              tooltip: `Claude finished ${timeAgo} (${elapsed}s ago)`,
            });
          } else {
            accessories.push({
              tag: { value: 'Claude', color: Color.Green },
              tooltip: 'Claude is running in this terminal',
            });
          }
        }

        // Terminal purpose
        accessories.push({
          text: purposeEmoji(terminal.purpose),
          tooltip: `Purpose: ${terminal.purpose}`,
        });

        // Current working directory
        if (cwdRelative !== '.') {
          accessories.push({
            text: cwdRelative,
            tooltip: terminal.cwd,
          });
        }

        // Last activity
        accessories.push({
          text: formatLastActivity(terminal.lastActivity),
          icon: { source: Icon.Clock, tintColor: Color.SecondaryText },
          tooltip: terminal.lastActivity
            ? `Last active: ${new Date(terminal.lastActivity * 1000).toLocaleString()}`
            : 'No activity recorded',
        });

        return (
          <List.Item
            key={terminal.terminalId}
            title={terminal.alias || terminal.name}
            subtitle={subtitle}
            icon={{
              source: Icon.Terminal,
              tintColor: terminal.hasClaude
                ? (terminal.claudeWorking ? Color.Blue : terminal.claudeWaiting ? Color.Orange : Color.Green)
                : (terminal.currentCommand ? Color.Green : Color.SecondaryText),
            }}
            accessories={accessories}
            actions={
              <ActionPanel>
                <Action
                  title="Switch to Terminal"
                  icon={Icon.ArrowRight}
                  onAction={() => switchToTerminal(terminal, true)}
                />
                <Action
                  title="Create New Terminal"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ['cmd'], key: 'n' }}
                  onAction={async () => {
                    if (!selectedInstanceObj) return;
                    const success = await createNewTerminal(selectedInstanceObj, '', '');
                    if (success) {
                      await focusVSCodeInstance(selectedInstanceObj.path);
                      await showToast({
                        style: Toast.Style.Success,
                        title: 'Terminal Created',
                        message: `New terminal opened in ${selectedInstanceObj.name}`,
                      });
                      // Refresh to show the new terminal
                      setTimeout(() => loadData(), 500);
                    } else {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: 'Failed to create terminal',
                        message: 'Redis connection unavailable',
                      });
                    }
                  }}
                />
                <Action.Push
                  title={terminal.alias ? "Edit Alias" : "Set Alias"}
                  icon={Icon.Pencil}
                  shortcut={{ modifiers: ['cmd'], key: 'e' }}
                  target={<SetTerminalAliasForm terminal={terminal} onAliasSet={loadData} />}
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
                  onAction={() => {
                    setSelectedInstance(null);
                    selectedInstanceRef.current = null;
                    setUserNavigatedBack(true);
                    userNavigatedBackRef.current = true;
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
