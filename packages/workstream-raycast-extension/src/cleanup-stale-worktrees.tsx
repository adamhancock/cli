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
  getPreferenceValues,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { getPRStatus } from './utils/github';

const execAsync = promisify(exec);

interface Preferences {
  codeFolder?: string;
}

interface StaleWorktree {
  path: string;
  branch: string;
  commit: string;
  reason: 'merged';
  prNumber: number;
  prTitle: string;
}

interface CleanupProgress {
  total: number;
  current: number;
  currentPath: string;
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Get git repositories from a folder
 */
async function getRepositories(folderPath: string): Promise<string[]> {
  const expandedPath = folderPath.replace(/^~/, homedir());

  if (!existsSync(expandedPath)) {
    return [];
  }

  try {
    const entries = readdirSync(expandedPath);
    const repos: string[] = [];

    for (const entry of entries) {
      const fullPath = resolve(expandedPath, entry);

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const gitPath = resolve(fullPath, '.git');
          if (existsSync(gitPath)) {
            repos.push(fullPath);
          }
        }
      } catch {
        // Skip entries that can't be accessed
        continue;
      }
    }

    return repos.sort();
  } catch (error) {
    return [];
  }
}

/**
 * Scan selected repositories for worktrees with merged PRs
 */
async function scanRepositories(
  repoPaths: string[],
  onProgress?: (status: string, repo?: { repoPath: string; worktrees: StaleWorktree[] }) => void
): Promise<Array<{ repoPath: string; worktrees: StaleWorktree[] }>> {
  const results: Array<{ repoPath: string; worktrees: StaleWorktree[] }> = [];

  onProgress?.(`Scanning ${repoPaths.length} repositories...`);

  for (let i = 0; i < repoPaths.length; i++) {
    const repoPath = repoPaths[i];
    const repoName = repoPath.split('/').pop() || repoPath;

    try {
      onProgress?.(`Checking worktrees in ${repoName} (${i + 1}/${repoPaths.length})...`);

      // Get worktree list
      const { stdout: worktreeList } = await execAsync('git worktree list --porcelain', { cwd: repoPath });
      const staleWorktrees = await parseStaleWorktrees(worktreeList, repoPath, (status) => {
        onProgress?.(status);
      });

      if (staleWorktrees.length > 0) {
        const repo = { repoPath, worktrees: staleWorktrees };
        results.push(repo);
        onProgress?.(`Found ${staleWorktrees.length} merged worktree(s) in ${repoName}`, repo);
      }
    } catch (error) {
      // Skip repos that have issues
      continue;
    }
  }

  onProgress?.('Scan complete');
  return results;
}

/**
 * Parse git worktree list output to find worktrees with merged PRs
 */
async function parseStaleWorktrees(
  output: string,
  repoPath: string,
  onProgress?: (status: string) => void
): Promise<StaleWorktree[]> {
  const worktrees: Array<{ path: string; branch?: string; commit?: string }> = [];
  const lines = output.split('\n');

  let currentWorktree: { path?: string; branch?: string; commit?: string } | null = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (currentWorktree?.path) {
        worktrees.push(currentWorktree as { path: string; branch?: string; commit?: string });
      }
      currentWorktree = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      if (currentWorktree) {
        currentWorktree.commit = line.substring(5);
      }
    } else if (line.startsWith('branch ')) {
      if (currentWorktree) {
        currentWorktree.branch = line.substring(7).replace('refs/heads/', '');
      }
    } else if (line.trim() === '') {
      if (currentWorktree?.path) {
        worktrees.push(currentWorktree as { path: string; branch?: string; commit?: string });
      }
      currentWorktree = null;
    }
  }

  // Don't forget the last one
  if (currentWorktree?.path) {
    worktrees.push(currentWorktree as { path: string; branch?: string; commit?: string });
  }

  // Filter out main worktree and worktrees without branches
  const worktreesToCheck = worktrees.filter(
    (w) => w.path !== repoPath && w.branch && w.branch !== 'main'
  );

  onProgress?.(`Checking ${worktreesToCheck.length} worktree(s) for PR status...`);

  // Now check each worktree for merged PRs
  const mergedWorktrees: StaleWorktree[] = [];

  for (let i = 0; i < worktreesToCheck.length; i++) {
    const worktree = worktreesToCheck[i];
    const worktreeName = worktree.path.split('/').pop() || worktree.path;

    onProgress?.(`Checking PR for ${worktreeName} (${i + 1}/${worktreesToCheck.length})...`);

    // Check PR status
    try {
      const prStatus = await getPRStatus(worktree.path, worktree.branch!);

      // Skip if no PR exists
      if (!prStatus) {
        continue;
      }

      // Only add if PR is MERGED
      if (prStatus.state === 'MERGED') {
        mergedWorktrees.push({
          path: worktree.path,
          branch: worktree.branch!,
          commit: worktree.commit || '',
          reason: 'merged',
          prNumber: prStatus.number,
          prTitle: prStatus.title,
        });
      }
    } catch (error) {
      // Couldn't get PR status, skip this worktree
      continue;
    }
  }

  return mergedWorktrees;
}

/**
 * Remove worktrees with merged PRs and delete their branches
 */
async function cleanupStaleWorktrees(
  repos: Array<{ repoPath: string; worktrees: StaleWorktree[] }>,
  onProgress: (progress: CleanupProgress) => void
): Promise<void> {
  const totalWorktrees = repos.reduce((sum, repo) => sum + repo.worktrees.length, 0);
  let current = 0;
  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      current++;
      onProgress({
        total: totalWorktrees,
        current,
        currentPath: worktree.path,
        removed: [...removed],
        failed: [...failed],
      });

      try {
        // Remove the worktree
        await execAsync(`git worktree remove "${worktree.path}" --force`, { cwd: repo.repoPath });

        // Delete the branch
        await execAsync(`git branch -D "${worktree.branch}"`, { cwd: repo.repoPath });

        removed.push(worktree.path);
      } catch (error) {
        failed.push({
          path: worktree.path,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Prune stale worktree entries for this repo
    try {
      await execAsync('git worktree prune', { cwd: repo.repoPath });
    } catch (error) {
      // Log but don't fail if prune fails
      console.error('Failed to prune worktrees:', error);
    }
  }

  // Final progress update
  onProgress({
    total: totalWorktrees,
    current: totalWorktrees,
    currentPath: '',
    removed,
    failed,
  });
}

function CleanupProgressView({
  repos,
  onComplete,
}: {
  repos: Array<{ repoPath: string; worktrees: StaleWorktree[] }>;
  onComplete: () => void;
}) {
  const [progress, setProgress] = useState<CleanupProgress>({
    total: 0,
    current: 0,
    currentPath: '',
    removed: [],
    failed: [],
  });
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function performCleanup() {
      await cleanupStaleWorktrees(repos, (p) => {
        if (mounted) {
          setProgress(p);
        }
      });

      if (mounted) {
        setIsComplete(true);

        await showToast({
          style: Toast.Style.Success,
          title: 'Cleanup Complete',
          message: `Removed ${progress.removed.length} worktree${progress.removed.length > 1 ? 's' : ''} and deleted ${progress.removed.length > 1 ? 'their branches' : 'branch'}`,
        });

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
  }, [repos, onComplete]);

  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const markdown = `# ${isComplete ? '✅' : '⏳'} Cleaning Up Merged PR Worktrees

${progress.current > 0 ? `\n**Progress:** ${progress.current}/${progress.total} (${progressPercent}%)\n` : ''}
${progress.currentPath ? `\n**Currently processing:** ${progress.currentPath}\n` : ''}

${progress.removed.length > 0 ? `## ✅ Removed (${progress.removed.length})\n${progress.removed.map((p) => `- ${p}`).join('\n')}\n` : ''}

${progress.failed.length > 0 ? `## ❌ Failed (${progress.failed.length})\n${progress.failed.map((f) => `- ${f.path}\n  Error: ${f.error}`).join('\n')}\n` : ''}

${!isComplete ? '\n⏳ Removing worktrees and deleting branches...' : '\n✅ Cleanup complete! Worktrees removed and branches deleted.'}
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

function RepositorySelector({ onSelect }: { onSelect: (repoPath: string) => void }) {
  const preferences = getPreferenceValues<Preferences>();
  const [repositories, setRepositories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadRepositories();
  }, []);

  async function loadRepositories() {
    setIsLoading(true);

    const codeFolder = preferences.codeFolder || '~/Code';
    const repos = await getRepositories(codeFolder);

    setRepositories(repos);
    setIsLoading(false);

    if (repos.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'No Repositories Found',
        message: `No git repositories found in ${codeFolder}. Check your Code Folder preference.`,
      });
    }
  }

  const preferences_codeFolder = preferences.codeFolder || '~/Code';

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search repositories...">
      {repositories.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="No Repositories Found"
          description={`No git repositories found in ${preferences_codeFolder}`}
        />
      ) : (
        <List.Section
          title={`${repositories.length} Repositories in ${preferences_codeFolder}`}
          subtitle="Select a repository to scan for merged PR worktrees"
        >
          {repositories.map((repoPath) => {
            const repoName = repoPath.split('/').pop() || repoPath;

            return (
              <List.Item
                key={repoPath}
                icon={Icon.Folder}
                title={repoName}
                subtitle={repoPath}
                actions={
                  <ActionPanel>
                    <Action
                      title="Scan Repository"
                      onAction={() => onSelect(repoPath)}
                      icon={Icon.MagnifyingGlass}
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

function WorktreeCleanupView({ repoPath }: { repoPath: string }) {
  const [repos, setRepos] = useState<Array<{ repoPath: string; worktrees: StaleWorktree[] }>>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState<string>('Starting scan...');
  const { push, pop } = useNavigation();

  useEffect(() => {
    scanForWorktrees();
  }, []);

  async function scanForWorktrees() {
    setIsLoading(true);
    setLoadingStatus('Starting scan...');
    setRepos([]);
    setSelectedPaths(new Set());

    try {
      const foundRepos = await scanRepositories([repoPath], (status, repo) => {
        setLoadingStatus(status);

        // If a repo with merged worktrees was found, add it immediately
        if (repo) {
          setRepos((prev) => {
            // Check if this repo already exists
            const existingIndex = prev.findIndex((r) => r.repoPath === repo.repoPath);
            if (existingIndex >= 0) {
              // Update existing repo
              const updated = [...prev];
              updated[existingIndex] = repo;
              return updated;
            } else {
              // Add new repo
              return [...prev, repo];
            }
          });

          // Auto-select newly found worktrees
          setSelectedPaths((prev) => {
            const next = new Set(prev);
            repo.worktrees.forEach((worktree) => {
              next.add(worktree.path);
            });
            return next;
          });
        }
      });

      setIsLoading(false);
      setLoadingStatus('');

      if (foundRepos.length === 0) {
        await showToast({
          style: Toast.Style.Success,
          title: 'No Merged PR Worktrees',
          message: 'No worktrees with merged pull requests found.',
        });
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: 'Scan Complete',
          message: `Found ${foundRepos.reduce((sum, r) => sum + r.worktrees.length, 0)} worktree(s) with merged PRs`,
        });
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to scan for worktrees',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setRepos([]);
      setIsLoading(false);
      setLoadingStatus('');
    }
  }

  function toggleSelection(path: string) {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function selectAll() {
    const allPaths = new Set<string>();
    repos.forEach(repo => {
      repo.worktrees.forEach(worktree => {
        allPaths.add(worktree.path);
      });
    });
    setSelectedPaths(allPaths);
  }

  function deselectAll() {
    setSelectedPaths(new Set());
  }

  async function confirmAndCleanup() {
    const selectedCount = selectedPaths.size;

    if (selectedCount === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'No worktrees selected',
        message: 'Please select at least one worktree to clean up.',
      });
      return;
    }

    const confirmed = await confirmAlert({
      title: `Clean up ${selectedCount} worktree${selectedCount > 1 ? 's' : ''} with merged PRs?`,
      message: `This will:
• Remove ${selectedCount} worktree${selectedCount > 1 ? 's' : ''}
• Delete ${selectedCount} branch${selectedCount > 1 ? 'es' : ''}
• Prune stale worktree entries

This action cannot be undone.`,
      primaryAction: {
        title: 'Clean Up',
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (confirmed) {
      // Filter repos to only include selected worktrees
      const reposToCleanup = repos.map(repo => ({
        ...repo,
        worktrees: repo.worktrees.filter(w => selectedPaths.has(w.path))
      })).filter(repo => repo.worktrees.length > 0);

      push(<CleanupProgressView repos={reposToCleanup} onComplete={() => pop()} />);
    }
  }

  const totalWorktrees = repos.reduce((sum, repo) => sum + repo.worktrees.length, 0);
  const selectedCount = selectedPaths.size;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search worktrees with merged PRs..."
      navigationTitle={isLoading && loadingStatus ? loadingStatus : 'Cleanup Merged PR Worktrees'}
    >
      {totalWorktrees === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="No Merged PR Worktrees"
          description="No worktrees found with merged pull requests."
        />
      ) : (
        <>
          {isLoading && loadingStatus && (
            <List.Section title="Scanning">
              <List.Item
                icon={Icon.ArrowClockwise}
                title={loadingStatus}
                accessories={[{ text: `${totalWorktrees} found so far` }]}
              />
            </List.Section>
          )}
          {totalWorktrees > 0 && (
            <List.Section
              title={`${totalWorktrees} Worktree${totalWorktrees > 1 ? 's' : ''} with Merged PRs`}
              subtitle={`${selectedCount} selected for cleanup`}
            >
              {repos.map((repo) =>
                repo.worktrees.map((worktree) => {
                  const isSelected = selectedPaths.has(worktree.path);
                  return (
                    <List.Item
                      key={worktree.path}
                      icon={{
                        source: isSelected ? Icon.CheckCircle : Icon.Circle,
                        tintColor: isSelected ? Color.Purple : Color.SecondaryText,
                      }}
                      title={worktree.path.split('/').pop() || worktree.path}
                      subtitle={`${worktree.branch} (#${worktree.prNumber})`}
                      accessories={[
                        {
                          text: isSelected ? 'Will Remove' : 'Will Keep',
                          tooltip: isSelected
                            ? 'This worktree will be removed'
                            : 'This worktree will be kept',
                        },
                        {
                          text: worktree.prTitle,
                          tooltip: `Pull request #${worktree.prNumber}: ${worktree.prTitle}`,
                        },
                      ]}
                      actions={
                        <ActionPanel>
                          <Action
                            title={isSelected ? 'Deselect' : 'Select'}
                            onAction={() => toggleSelection(worktree.path)}
                            icon={isSelected ? Icon.Circle : Icon.CheckCircle}
                          />
                          <Action
                            title={`Clean Up ${selectedCount} Selected Worktree${selectedCount !== 1 ? 's' : ''}`}
                            onAction={confirmAndCleanup}
                            icon={Icon.Trash}
                            style={Action.Style.Destructive}
                            shortcut={{ modifiers: ['cmd'], key: 'enter' }}
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
                            onAction={scanForWorktrees}
                            icon={Icon.ArrowClockwise}
                            shortcut={{ modifiers: ['cmd'], key: 'r' }}
                          />
                        </ActionPanel>
                      }
                    />
                  );
                })
              )}
            </List.Section>
          )}
        </>
      )}
    </List>
  );
}

export default function CleanupStaleWorktreesCommand() {
  const { push } = useNavigation();

  return (
    <RepositorySelector
      onSelect={(repoPath) => {
        push(<WorktreeCleanupView repoPath={repoPath} />);
      }}
    />
  );
}
