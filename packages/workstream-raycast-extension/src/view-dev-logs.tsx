import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Detail,
  useNavigation,
  Clipboard,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { getVSCodeInstances } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getTmuxSessionInfo, getTmuxSessionOutput } from './utils/tmux';
import { loadFromDaemon } from './utils/daemon-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InstanceWithStatus } from './types';

const execAsync = promisify(exec);

interface LogViewerProps {
  sessionName: string;
  instanceName: string;
  onBack: () => void;
}

function LogViewer({ sessionName, instanceName, onBack }: LogViewerProps) {
  const [logs, setLogs] = useState<string>('');
  const [lineCount, setLineCount] = useState<number>(1000);
  const [isLoading, setIsLoading] = useState(true);
  const [liveTail, setLiveTail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load logs
  async function loadLogs(lines: number) {
    setIsLoading(true);
    setError(null);
    try {
      console.log(`Loading logs for session: ${sessionName}, lines: ${lines}`);
      const output = await getTmuxSessionOutput(sessionName, lines);
      console.log(`Received ${output.length} characters, ${output.split('\n').length} lines`);

      // Reverse log lines so newest appears at the top
      const reversedLogs = output.split('\n').reverse().join('\n');
      setLogs(reversedLogs);
      setIsLoading(false);
    } catch (err) {
      console.error('Error loading logs:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsLoading(false);
    }
  }

  // Initial load
  useEffect(() => {
    loadLogs(lineCount);
  }, [sessionName, lineCount]);

  // Live tail mode
  useEffect(() => {
    if (!liveTail) return;

    const interval = setInterval(() => {
      loadLogs(lineCount);
    }, 2000); // Refresh every 2 seconds

    return () => clearInterval(interval);
  }, [liveTail, lineCount]);

  // Copy logs to clipboard
  async function copyToClipboard() {
    await Clipboard.copy(logs);
    await showToast({
      style: Toast.Style.Success,
      title: 'Copied to clipboard',
      message: `${logs.split('\n').length} lines copied`,
    });
  }

  // Open logs in VS Code
  async function openInEditor() {
    try {
      const tempFile = path.join(os.tmpdir(), `tmux-${sessionName}-${Date.now()}.log`);
      fs.writeFileSync(tempFile, logs);

      await execAsync(`code "${tempFile}"`);
      await showToast({
        style: Toast.Style.Success,
        title: 'Opened in VS Code',
        message: tempFile,
      });
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to open in editor',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  const lineCountText = lineCount === -1 ? 'All' : lineCount.toLocaleString();
  const linesInLog = logs.split('\n').length;
  const statusIcon = liveTail ? '🔴' : error ? '❌' : '📋';

  const markdown = `# ${statusIcon} Dev Environment Logs

**Session:** \`${sessionName}\`
**Instance:** ${instanceName}
**Lines:** ${linesInLog.toLocaleString()} (showing ${lineCountText})
${liveTail ? '**Status:** 🔴 Live Tail (auto-refresh every 2s)\n' : ''}
${error ? `\n**Error:** ${error}\n` : ''}

_Newest logs appear at the top ⬆️_

---

\`\`\`
${logs || 'No logs available'}
\`\`\`
`;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Navigation">
            <Action title="Back to Sessions" onAction={onBack} icon={Icon.ArrowLeft} />
            <Action
              title="Refresh"
              onAction={() => loadLogs(lineCount)}
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ['cmd'], key: 'r' }}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Live Tail">
            <Action
              title={liveTail ? 'Stop Live Tail' : 'Start Live Tail'}
              onAction={() => setLiveTail(!liveTail)}
              icon={liveTail ? Icon.Stop : Icon.Play}
              shortcut={{ modifiers: ['cmd'], key: 'l' }}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Line Count">
            <Action
              title="Show 50 Lines"
              onAction={() => setLineCount(50)}
              icon={Icon.Text}
              shortcut={{ modifiers: ['cmd', 'shift'], key: '1' }}
            />
            <Action
              title="Show 100 Lines"
              onAction={() => setLineCount(100)}
              icon={Icon.Text}
              shortcut={{ modifiers: ['cmd', 'shift'], key: '2' }}
            />
            <Action
              title="Show 500 Lines"
              onAction={() => setLineCount(500)}
              icon={Icon.Text}
              shortcut={{ modifiers: ['cmd', 'shift'], key: '3' }}
            />
            <Action
              title="Show 1000 Lines"
              onAction={() => setLineCount(1000)}
              icon={Icon.Text}
              shortcut={{ modifiers: ['cmd', 'shift'], key: '4' }}
            />
            <Action
              title="Show All Lines"
              onAction={() => setLineCount(-1)}
              icon={Icon.Text}
              shortcut={{ modifiers: ['cmd', 'shift'], key: '5' }}
            />
          </ActionPanel.Section>

          <ActionPanel.Section title="Export">
            <Action
              title="Copy to Clipboard"
              onAction={copyToClipboard}
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ['cmd'], key: 'c' }}
            />
            <Action
              title="Open in VS Code"
              onAction={openInEditor}
              icon={Icon.Code}
              shortcut={{ modifiers: ['cmd'], key: 'o' }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

export default function ViewDevLogsCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { push, pop } = useNavigation();

  useEffect(() => {
    loadInstances();
  }, []);

  async function loadInstances() {
    setIsLoading(true);

    try {
      // Try daemon first (fastest)
      const daemonCache = await loadFromDaemon();
      if (daemonCache && daemonCache.instances.length > 0) {
        const withTmux = daemonCache.instances.filter((i) => i.tmuxStatus?.exists);
        setInstances(withTmux);
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

      // Enrich with git and tmux info
      const enriched = await Promise.all(
        basicInstances.map(async (instance) => {
          const enrichedInstance: InstanceWithStatus = { ...instance };

          try {
            if (instance.isGitRepo) {
              enrichedInstance.gitInfo = (await getGitInfo(instance.path)) || undefined;
            }

            // Get tmux status
            const tmuxInfo = await getTmuxSessionInfo(
              instance.path,
              enrichedInstance.gitInfo?.branch
            );
            if (tmuxInfo) {
              enrichedInstance.tmuxStatus = tmuxInfo;
            }
          } catch (error) {
            enrichedInstance.error = error instanceof Error ? error.message : 'Unknown error';
          }

          return enrichedInstance;
        })
      );

      // Filter to only instances with active tmux sessions
      const withTmux = enriched.filter((i) => i.tmuxStatus?.exists);
      setInstances(withTmux);
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

  function viewLogs(instance: InstanceWithStatus) {
    if (!instance.tmuxStatus?.name) return;

    push(
      <LogViewer
        sessionName={instance.tmuxStatus.name}
        instanceName={instance.name}
        onBack={() => pop()}
      />
    );
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    if (instance.gitInfo) {
      parts.push(`⎇ ${instance.gitInfo.branch}`);
    }

    if (instance.tmuxStatus?.name) {
      parts.push(`Session: ${instance.tmuxStatus.name}`);
    }

    return parts.join(' • ');
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search dev environments...">
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Terminal}
          title="No active dev environments"
          description="Start a dev environment to view its logs here"
        />
      ) : (
        instances.map((instance) => (
          <List.Item
            key={instance.path}
            icon={{ source: Icon.Terminal, tintColor: Color.Green }}
            title={instance.name}
            subtitle={getSubtitle(instance)}
            accessories={[
              {
                icon: { source: Icon.Eye, tintColor: Color.Blue },
                tooltip: 'View logs',
              },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="View Logs"
                  onAction={() => viewLogs(instance)}
                  icon={Icon.Eye}
                />
                <Action
                  title="Refresh"
                  onAction={loadInstances}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action.ShowInFinder path={instance.path} />
                <Action.CopyToClipboard title="Copy Path" content={instance.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
