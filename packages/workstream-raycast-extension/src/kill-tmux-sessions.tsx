import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Alert,
  confirmAlert,
} from '@raycast/api';
import { useState, useEffect, useCallback } from 'react';
import { listTmuxSessions, killTmuxSession, TmuxSession } from './utils/tmux';

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function KillTmuxSessionsCommand() {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    try {
      const found = await listTmuxSessions();
      setSessions(found);
      setSelectedNames(new Set(found.map((s) => s.name)));
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to list tmux sessions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  function toggleSelection(name: string) {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedNames(new Set(sessions.map((s) => s.name)));
  }

  function deselectAll() {
    setSelectedNames(new Set());
  }

  async function killSingle(name: string) {
    try {
      await killTmuxSession(name);
      await showToast({ style: Toast.Style.Success, title: `Killed session: ${name}` });
      await loadSessions();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: `Failed to kill ${name}`,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function killSelected() {
    if (selectedNames.size === 0) {
      await showToast({ style: Toast.Style.Failure, title: 'No sessions selected' });
      return;
    }

    const confirmed = await confirmAlert({
      title: `Kill ${selectedNames.size} tmux session${selectedNames.size > 1 ? 's' : ''}?`,
      message: `Sessions to kill:\n${Array.from(selectedNames)
        .map((n) => `• ${n}`)
        .join('\n')}`,
      primaryAction: {
        title: 'Kill Sessions',
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (!confirmed) return;

    let killed = 0;
    let failed = 0;

    for (const name of selectedNames) {
      try {
        await killTmuxSession(name);
        killed++;
      } catch {
        failed++;
      }
    }

    await showToast({
      style: failed > 0 ? Toast.Style.Failure : Toast.Style.Success,
      title: `Killed ${killed} session${killed !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
    });

    await loadSessions();
  }

  const selectedCount = selectedNames.size;

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search tmux sessions...">
      {sessions.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Terminal}
          title="No tmux sessions running"
          description="There are no active tmux sessions to kill."
        />
      ) : (
        <List.Section
          title={`${sessions.length} Tmux Session${sessions.length !== 1 ? 's' : ''} Running`}
          subtitle={selectedCount > 0 ? `${selectedCount} selected` : undefined}
        >
          {sessions.map((session) => {
            const isSelected = selectedNames.has(session.name);
            return (
              <List.Item
                key={session.name}
                icon={{
                  source: isSelected ? Icon.CheckCircle : Icon.Circle,
                  tintColor: isSelected ? Color.Purple : Color.SecondaryText,
                }}
                title={session.name}
                subtitle={`Created ${formatTimeAgo(session.created)}`}
                accessories={[
                  {
                    text: `Active ${formatTimeAgo(session.lastActivity)}`,
                    tooltip: `Last activity: ${session.lastActivity.toLocaleString()}`,
                  },
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title={`Kill ${selectedCount} Selected Session${selectedCount !== 1 ? 's' : ''}`}
                      onAction={killSelected}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                    />
                    <Action
                      title={isSelected ? 'Deselect' : 'Select'}
                      onAction={() => toggleSelection(session.name)}
                      icon={isSelected ? Icon.Circle : Icon.CheckCircle}
                      shortcut={{ modifiers: ['cmd'], key: 's' }}
                    />
                    <Action
                      title="Kill This Session Only"
                      onAction={() => killSingle(session.name)}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ['cmd', 'shift'], key: 'enter' }}
                    />
                    <Action
                      title="Select All"
                      onAction={selectAll}
                      icon={Icon.CheckCircle}
                      shortcut={{ modifiers: ['cmd'], key: 'a' }}
                    />
                    <Action
                      title="Deselect All"
                      onAction={deselectAll}
                      icon={Icon.Circle}
                      shortcut={{ modifiers: ['cmd', 'shift'], key: 'a' }}
                    />
                    <Action
                      title="Refresh"
                      onAction={loadSessions}
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['cmd'], key: 'r' }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
