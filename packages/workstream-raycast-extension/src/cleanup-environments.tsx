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
  Detail,
  useNavigation,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { getVSCodeInstances } from './utils/vscode';
import { getGitInfo } from './utils/git';
import { getPRStatus } from './utils/github';
import { getTmuxSessionInfo } from './utils/tmux';
import { findHostByWorktreePath } from './utils/caddy';
import { findEnvironmentsForCleanup, closeEnvironments, getCleanupSummary } from './utils/cleanup';
import { CleanupCriteria, type InstanceWithStatus, type CleanupResult } from './types';
import { triggerDaemonRefresh } from './utils/daemon-client';

function CleanupProgress({ instances, onComplete }: { instances: InstanceWithStatus[]; onComplete: () => void }) {
  const [progress, setProgress] = useState<string[]>([]);
  const [currentInstance, setCurrentInstance] = useState<string>('');
  const [isComplete, setIsComplete] = useState(false);
  const [results, setResults] = useState<CleanupResult[]>([]);

  useEffect(() => {
    let mounted = true;

    async function performCleanup() {
      const cleanupResults = await closeEnvironments(instances, (instanceName, step) => {
        if (mounted) {
          setCurrentInstance(instanceName);
          setProgress((prev) => [...prev, `[${instanceName}] ${step}`]);
        }
      });

      if (mounted) {
        setResults(cleanupResults);
        setIsComplete(true);
        setProgress((prev) => [...prev, '\n✅ Cleanup complete!']);

        // Trigger daemon refresh to update the main VS Code instance list
        await triggerDaemonRefresh();

        // Show success toast
        const successCount = cleanupResults.filter((r) => r.success).length;
        await showToast({
          style: Toast.Style.Success,
          title: 'Cleanup Complete',
          message: `Closed ${successCount}/${cleanupResults.length} environments`,
        });

        // Call completion callback
        setTimeout(() => {
          if (mounted) {
            onComplete();
          }
        }, 2000);
      }
    }

    performCleanup();

    return () => {
      mounted = false;
    };
  }, [instances, onComplete]);

  const progressText = progress.join('\n');
  const statusEmoji = isComplete ? '✅' : '⏳';

  const markdown = `# ${statusEmoji} Cleaning Up ${instances.length} Environment${instances.length > 1 ? 's' : ''}

${currentInstance ? `\n**Currently processing:** ${currentInstance}\n` : ''}

\`\`\`
${progressText || 'Starting cleanup...'}
${!isComplete ? '\n⏳ Working...' : ''}
\`\`\`

${isComplete ? '\n## Summary\n' : ''}
${isComplete ? results.map((r) => `- ${r.success ? '✅' : '❌'} **${r.instanceName}**${r.error ? ` - ${r.error}` : ''}\n  - VS Code: ${r.vscodeClosed ? '✅' : '❌'} | Tmux: ${r.tmuxClosed ? '✅' : '❌'} | Caddy: ${r.caddyRouteClosed ? '✅' : '❌'} | Worktree: ${r.worktreeRemoved ? '✅' : '❌'}`).join('\n') : ''}
  `;

  return (
    <Detail
      markdown={markdown}
      actions={
        isComplete ? (
          <ActionPanel>
            <Action title="Done" onAction={onComplete} />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}

export default function CleanupEnvironmentsCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [criteria, setCriteria] = useState<CleanupCriteria[]>([
    CleanupCriteria.MergedPRs,
    CleanupCriteria.ClosedPRs,
  ]);
  const [selectedInstances, setSelectedInstances] = useState<InstanceWithStatus[]>([]);
  const { push, pop } = useNavigation();

  useEffect(() => {
    loadInstances();
  }, []);

  useEffect(() => {
    // Update selected instances when criteria changes
    if (instances.length > 0) {
      const matchingInstances = findEnvironmentsForCleanup(instances, criteria);
      setSelectedInstances(matchingInstances);
    }
  }, [criteria, instances]);

  async function loadInstances() {
    setIsLoading(true);

    try {
      const basicInstances = await getVSCodeInstances();

      if (basicInstances.length === 0) {
        setInstances([]);
        setIsLoading(false);
        return;
      }

      // Enrich with metadata
      const enriched = await Promise.all(
        basicInstances.map(async (instance) => {
          const enrichedInstance: InstanceWithStatus = { ...instance };

          try {
            if (instance.isGitRepo) {
              enrichedInstance.gitInfo = (await getGitInfo(instance.path)) || undefined;

              if (enrichedInstance.gitInfo) {
                enrichedInstance.prStatus = (await getPRStatus(instance.path, enrichedInstance.gitInfo.branch)) || undefined;
              }
            }

            // Get tmux status
            const tmuxInfo = await getTmuxSessionInfo(instance.path);
            if (tmuxInfo) {
              enrichedInstance.tmuxStatus = tmuxInfo;
            }

            // Get Caddy host info
            const caddyHost = await findHostByWorktreePath(instance.path);
            if (caddyHost) {
              enrichedInstance.caddyHost = caddyHost;
            }
          } catch (error) {
            enrichedInstance.error = error instanceof Error ? error.message : 'Unknown error';
          }

          return enrichedInstance;
        })
      );

      setInstances(enriched);
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load instances',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
  }

  function toggleCriteria(criterion: CleanupCriteria) {
    setCriteria((prev) => {
      if (prev.includes(criterion)) {
        return prev.filter((c) => c !== criterion);
      } else {
        return [...prev, criterion];
      }
    });
  }

  async function confirmAndCleanup() {
    if (selectedInstances.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'No environments selected',
        message: 'Please select at least one cleanup criterion',
      });
      return;
    }

    const summary = getCleanupSummary(selectedInstances);

    const confirmed = await confirmAlert({
      title: `Clean up ${selectedInstances.length} environment${selectedInstances.length > 1 ? 's' : ''}?`,
      message: `This will close:
• ${selectedInstances.length} VS Code window${selectedInstances.length > 1 ? 's' : ''}
• ${summary.withTmux} tmux session${summary.withTmux > 1 ? 's' : ''}
• ${summary.withCaddy} Caddy route${summary.withCaddy > 1 ? 's' : ''}

This action cannot be undone.`,
      primaryAction: {
        title: 'Clean Up',
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (confirmed) {
      push(<CleanupProgress instances={selectedInstances} onComplete={() => pop()} />);
    }
  }

  const summary = getCleanupSummary(selectedInstances);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search environments to clean up..."
      searchBarAccessory={
        <List.Dropdown tooltip="Filter Criteria" onChange={(value) => {
          const selected = value.split(',').filter(Boolean) as CleanupCriteria[];
          setCriteria(selected);
        }} value={criteria.join(',')}>
          <List.Dropdown.Item title="Merged PRs Only" value={CleanupCriteria.MergedPRs} />
          <List.Dropdown.Item title="Closed PRs Only" value={CleanupCriteria.ClosedPRs} />
          <List.Dropdown.Item title="Merged + Closed PRs" value={`${CleanupCriteria.MergedPRs},${CleanupCriteria.ClosedPRs}`} />
          <List.Dropdown.Item title="Old Worktrees Only" value={CleanupCriteria.OldWorktrees} />
          <List.Dropdown.Item title="All Criteria" value={`${CleanupCriteria.MergedPRs},${CleanupCriteria.ClosedPRs},${CleanupCriteria.OldWorktrees}`} />
        </List.Dropdown>
      }
    >
      {selectedInstances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="No environments match cleanup criteria"
          description={`No environments found with ${criteria.map((c) => c).join(', ')} status`}
        />
      ) : (
        <>
          <List.Section title={`${selectedInstances.length} Environment${selectedInstances.length > 1 ? 's' : ''} Will Be Cleaned Up`} subtitle={`${summary.withTmux} with tmux • ${summary.withCaddy} with Caddy`}>
            {selectedInstances.map((instance) => (
              <List.Item
                key={instance.path}
                icon={{
                  source:
                    instance.prStatus?.state === 'MERGED'
                      ? Icon.CheckCircle
                      : instance.prStatus?.state === 'CLOSED'
                        ? Icon.XMarkCircle
                        : Icon.Clock,
                  tintColor:
                    instance.prStatus?.state === 'MERGED'
                      ? Color.Purple
                      : instance.prStatus?.state === 'CLOSED'
                        ? Color.SecondaryText
                        : Color.Yellow,
                }}
                title={instance.name}
                subtitle={getSubtitle(instance)}
                accessories={getAccessories(instance)}
                actions={
                  <ActionPanel>
                    <Action
                      title={`Clean Up ${selectedInstances.length} Environment${selectedInstances.length > 1 ? 's' : ''}`}
                      onAction={confirmAndCleanup}
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                    />
                    <Action title="Refresh" onAction={loadInstances} icon={Icon.ArrowClockwise} shortcut={{ modifiers: ['cmd'], key: 'r' }} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        </>
      )}
    </List>
  );
}

function getSubtitle(instance: InstanceWithStatus): string {
  const parts: string[] = [];

  if (instance.gitInfo) {
    parts.push(`⎇ ${instance.gitInfo.branch}`);

    if (instance.prStatus) {
      let prDisplay = `#${instance.prStatus.number}`;

      if (instance.prStatus.state === 'MERGED') {
        prDisplay += ' ✓ merged';
      } else if (instance.prStatus.state === 'CLOSED') {
        prDisplay += ' ✗ closed';
      }

      parts.push(prDisplay);
    }
  }

  return parts.join(' • ');
}

function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  if (instance.tmuxStatus?.exists) {
    accessories.push({
      icon: { source: Icon.Terminal, tintColor: Color.Green },
      tooltip: `Tmux session: ${instance.tmuxStatus.name}`,
    });
  }

  if (instance.caddyHost) {
    accessories.push({
      icon: { source: Icon.Globe, tintColor: Color.Blue },
      tooltip: `Caddy route: ${instance.caddyHost.name}`,
    });
  }

  if (instance.gitInfo?.isDirty) {
    const changes = (instance.gitInfo.modified || 0) + (instance.gitInfo.staged || 0) + (instance.gitInfo.untracked || 0);
    accessories.push({
      text: `${changes} changes`,
      tooltip: 'Unsaved changes in worktree',
      icon: { source: Icon.ExclamationMark, tintColor: Color.Orange },
    });
  }

  return accessories;
}
