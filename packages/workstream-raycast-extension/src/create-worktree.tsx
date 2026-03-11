import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  closeMainWindow,
  popToRoot,
  Icon,
  getPreferenceValues,
} from '@raycast/api';
import { useEffect, useState, useCallback } from 'react';
import { createWorktreeStreaming } from './utils/worktree';
import { triggerDaemonRefresh, publishWorktreeJob, subscribeToWorktreeUpdates, getWorktreeJobStatus, type WorktreeUpdate } from './utils/daemon-client';
import { getUnmergedBranches, branchExists as checkBranchExists, getLocalBranches, getRemoteBranches } from './utils/git';
import { updateNotionTaskStatus, createNotionTask, fetchNotionPageByUrl, extractNotionPageId, extractSlugFromNotionUrl } from './utils/notion-client';
import type { NotionTask } from './types';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { writeFile } from 'fs/promises';

interface Preferences {
  defaultRepoPath?: string;
  devDomain?: string;
}

interface FormValues {
  worktreeName: string;
  repoPath: string;
  baseBranch?: string;
  createOwnUpstream?: boolean;
}

/**
 * Parse output message to extract a user-friendly status message
 */
function parseStatusMessage(output: string): string {
  const lines = output.trim().split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';

  // Map common messages to friendly status
  if (lastLine.includes('Fetching latest from')) return 'Fetching from remote...';
  if (lastLine.includes('Pulling latest changes')) return 'Pulling latest changes...';
  if (lastLine.includes('Creating worktree')) return 'Creating worktree...';
  if (lastLine.includes('Setting upstream')) return 'Configuring branch tracking...';
  if (lastLine.includes('Copying .env')) return 'Copying environment files...';
  if (lastLine.includes('Opening VS Code')) return 'Opening VS Code...';
  if (lastLine.includes('Installing dependencies') || lastLine.includes('pnpm install') || lastLine.includes('npm install') || lastLine.includes('yarn install')) return 'Installing dependencies...';
  if (lastLine.includes('Running post-create hooks')) return 'Running setup hooks...';
  if (lastLine.includes('Worktree created successfully')) return 'Finishing up...';
  if (lastLine.includes('Pruning stale')) return 'Cleaning up stale entries...';

  // Return a truncated version of the last line if no match
  return lastLine.length > 50 ? lastLine.substring(0, 47) + '...' : lastLine || 'Starting...';
}

/**
 * Check if VS Code has been opened based on output
 */
function hasVSCodeOpened(output: string): boolean {
  return output.includes('Opening VS Code') || output.includes('VS Code opened');
}

/**
 * Calculate the worktree path from repo path and branch name
 */
function calculateWorktreePath(repoPath: string, branchName: string): string {
  const repoName = basename(repoPath);
  return join(dirname(repoPath), `${repoName}-${branchName}`);
}

/**
 * Write a brief.md file with Notion task details to the worktree
 */
async function writeBriefFile(worktreePath: string, task: NotionTask): Promise<void> {
  const notionDetails = task.contentMarkdown?.trim() || '_No additional context was available from Notion._';
  const briefContent = `# ${task.taskId}: ${task.title}

**Status:** ${task.status}
**Notion:** [Open in Notion](${task.url})
**Branch:** \`${task.branchName}\`

---

## Notion Details

${notionDetails}

---

*This file was auto-generated when creating the worktree.*
`;

  const briefPath = join(worktreePath, 'brief.md');
  try {
    await writeFile(briefPath, briefContent, 'utf-8');
    console.log(`Brief written to ${briefPath}`);
  } catch (error) {
    console.error('Failed to write brief.md:', error);
  }
}

/**
 * Start worktree creation - hands off to daemon and closes once VS Code opens
 * Progress continues to be shown in VS Code's status bar via the extension
 */
async function startWorktreeCreation(
  worktreeName: string,
  repoPath: string,
  baseBranch?: string,
  force?: boolean,
  createOwnUpstream?: boolean,
  notionTask?: NotionTask | null
): Promise<void> {
  // Create an animated toast for progress
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Creating worktree: ${worktreeName}`,
    message: 'Starting...',
  });

  let lastOutput = '';
  let handedOff = false;

  // Helper to close Raycast after handoff
  const closeRaycast = async () => {
    if (handedOff) return;
    handedOff = true;

    // If a Notion task was selected, write brief.md and update status
    if (notionTask) {
      const worktreePath = calculateWorktreePath(repoPath, worktreeName);

      // Write the brief.md file
      toast.message = 'Writing task brief...';
      await writeBriefFile(worktreePath, notionTask);

      // Update Notion task status to "In Progress"
      toast.message = 'Updating Notion task status...';
      const result = await updateNotionTaskStatus(notionTask.id, 'In Progress');
      if (result.success) {
        console.log('Notion task status updated to In Progress');
      } else {
        console.error('Failed to update Notion task status:', result.error);
      }
    }

    toast.style = Toast.Style.Success;
    toast.title = 'Handed off to VS Code';
    toast.message = notionTask ? 'Brief created & task marked In Progress' : 'Progress continues in VS Code status bar';

    // Close Raycast after a short delay
    setTimeout(async () => {
      await closeMainWindow();
      await popToRoot();
    }, 800);
  };

  // Try to use daemon-based worktree creation
  const jobId = await publishWorktreeJob(worktreeName, repoPath, baseBranch, force, createOwnUpstream, !!notionTask);

  if (!jobId) {
    // Fallback to direct worktree creation if daemon is unavailable
    console.log('Daemon unavailable, falling back to direct worktree creation');
    toast.message = 'Running locally (daemon unavailable)...';

    const result = await createWorktreeStreaming(
      worktreeName,
      { repoPath, baseBranch, force, createOwnUpstream },
      (chunk) => {
        lastOutput += chunk;
        toast.message = parseStatusMessage(lastOutput);

        // Close Raycast once VS Code opens
        if (hasVSCodeOpened(lastOutput)) {
          closeRaycast();
        }
      }
    );

    // Handle final result if we haven't handed off yet
    if (!handedOff) {
      if (result.success) {
        // Set autolaunch key for fallback path
        if (result.worktreePath) {
          try {
            const { isRedisAvailable: checkRedis, getPublisherClient: getPub } = await import('./utils/redis-client');
            if (await checkRedis()) {
              const pub = getPub();
              const workspace = Buffer.from(result.worktreePath).toString('base64');
              const autolaunchKey = `workstream:terminal:autolaunch:${workspace}`;
              const payload: { command: string; terminalName: string; initialInput?: string } = { command: 'clauded', terminalName: 'Claude' };
              if (notionTask) {
                payload.initialInput = '/brief';
              }
              await pub.set(autolaunchKey, JSON.stringify(payload), 'EX', 60);
            }
          } catch (err) {
            console.error('Failed to set autolaunch key:', err);
          }
        }

        toast.style = Toast.Style.Success;
        toast.title = 'Worktree created successfully';
        toast.message = worktreeName;
        await triggerDaemonRefresh();
        setTimeout(async () => {
          await closeMainWindow();
          await popToRoot();
        }, 1500);
      } else {
        toast.style = Toast.Style.Failure;
        toast.title = 'Failed to create worktree';
        toast.message = result.error || 'Unknown error';
      }
    }
    return;
  }

  // Handler for processing updates from daemon
  const handleUpdate = async (update: WorktreeUpdate) => {
    if (handedOff) return;

    // Update toast with latest status
    if (update.output) {
      lastOutput += update.output;
      toast.message = parseStatusMessage(lastOutput);

      // Close Raycast once VS Code opens
      if (hasVSCodeOpened(lastOutput)) {
        unsubscribe();
        clearInterval(pollInterval);
        await closeRaycast();
        return;
      }
    }

    // Handle early failure states (before VS Code opens)
    if (update.status === 'failed') {
      unsubscribe();
      clearInterval(pollInterval);
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to create worktree';
      toast.message = update.error || 'Unknown error';
    } else if (update.status === 'skipped') {
      unsubscribe();
      clearInterval(pollInterval);
      toast.style = Toast.Style.Failure;
      toast.title = 'Worktree creation skipped';
      toast.message = 'Another job is already creating this worktree';
    }
  };

  // Subscribe to updates for this job
  console.log(`Subscribing to worktree job: ${jobId}`);
  const unsubscribe = subscribeToWorktreeUpdates(jobId, handleUpdate, async () => {
    // Error callback - fallback to direct creation
    if (!handedOff) {
      console.log('Redis subscription failed, falling back to direct creation');
      toast.message = 'Switching to local mode...';

      const result = await createWorktreeStreaming(
        worktreeName,
        { repoPath, baseBranch, force, createOwnUpstream },
        (chunk) => {
          lastOutput += chunk;
          toast.message = parseStatusMessage(lastOutput);

          if (hasVSCodeOpened(lastOutput)) {
            closeRaycast();
          }
        }
      );

      if (!handedOff) {
        if (result.success) {
          toast.style = Toast.Style.Success;
          toast.title = 'Worktree created successfully';
          toast.message = worktreeName;
          await triggerDaemonRefresh();
          setTimeout(async () => {
            await closeMainWindow();
            await popToRoot();
          }, 1500);
        } else {
          toast.style = Toast.Style.Failure;
          toast.title = 'Failed to create worktree';
          toast.message = result.error || 'Unknown error';
        }
      }
    }
  });

  // Poll for status as a fallback (in case pub/sub misses the update)
  const pollInterval = setInterval(async () => {
    if (handedOff) {
      clearInterval(pollInterval);
      unsubscribe();
      return;
    }

    try {
      const status = await getWorktreeJobStatus(jobId);

      if (status && status.output) {
        // Check if VS Code has opened from polled status
        if (hasVSCodeOpened(status.output)) {
          clearInterval(pollInterval);
          unsubscribe();
          await closeRaycast();
          return;
        }
      }

      // Handle failure from poll
      if (status && status.status === 'failed') {
        clearInterval(pollInterval);
        unsubscribe();
        toast.style = Toast.Style.Failure;
        toast.title = 'Failed to create worktree';
        toast.message = status.error || 'Unknown error';
      } else if (status && status.status === 'skipped') {
        clearInterval(pollInterval);
        unsubscribe();
        toast.style = Toast.Style.Failure;
        toast.title = 'Worktree creation skipped';
        toast.message = 'Another job is already creating this worktree';
      }
    } catch (e) {
      console.error('Poll error:', e);
    }
  }, 1000);

  // Set a timeout to clean up after 2 minutes (VS Code should open much sooner)
  setTimeout(() => {
    if (!handedOff) {
      clearInterval(pollInterval);
      unsubscribe();
      toast.style = Toast.Style.Failure;
      toast.title = 'Worktree creation timed out';
      toast.message = 'VS Code did not open in time';
    }
  }, 2 * 60 * 1000);
}

/**
 * Form component for creating a new Notion task
 */
function CreateNotionTaskForm({
  onTaskCreated,
}: {
  onTaskCreated: (task: NotionTask) => void;
}) {
  const [isCreating, setIsCreating] = useState(false);

  async function handleSubmit(values: { taskTitle: string }) {
    if (!values.taskTitle.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Title required',
        message: 'Please enter a title for the task',
      });
      return;
    }

    setIsCreating(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Creating task...',
    });

    try {
      const result = await createNotionTask(values.taskTitle.trim());

      if (result.success && result.task) {
        toast.style = Toast.Style.Success;
        toast.title = 'Task created';
        toast.message = `${result.task.taskId || ''} - ${result.task.title}`;

        // Notify parent and pop back
        onTaskCreated(result.task);
        await popToRoot();
      } else {
        toast.style = Toast.Style.Failure;
        toast.title = 'Failed to create task';
        toast.message = result.error || 'Unknown error';
      }
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to create task';
      toast.message = error instanceof Error ? error.message : 'Unknown error';
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Form
      isLoading={isCreating}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Task" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="taskTitle"
        title="Task Title"
        placeholder="Enter task title..."
        info="A new task will be created in your Notion database with status 'Not started'"
        autoFocus
      />
    </Form>
  );
}

export default function CreateWorktreeCommand() {
  const preferences = getPreferenceValues<Preferences>();
  const [branchSuggestions, setBranchSuggestions] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [branchName, setBranchName] = useState('');
  const defaultPath = preferences.defaultRepoPath
    ? preferences.defaultRepoPath.replace(/^~/, homedir())
    : join(homedir(), 'Code');
  const [repoPath, setRepoPath] = useState(defaultPath);
  const [showBaseBranchSelector, setShowBaseBranchSelector] = useState(false);
  const [isCheckingBranch, setIsCheckingBranch] = useState(false);
  const [notionUrl, setNotionUrl] = useState('');
  const [isLoadingNotionPage, setIsLoadingNotionPage] = useState(false);
  const [selectedNotionTask, setSelectedNotionTask] = useState<NotionTask | null>(null);
  const [notionPageError, setNotionPageError] = useState<string | null>(null);

  // Load unmerged branches on mount
  useEffect(() => {
    loadBranchSuggestions();
  }, [repoPath]);

  async function loadBranchSuggestions() {
    if (!repoPath) return;

    setIsLoadingSuggestions(true);
    try {
      const { local, remote } = await getUnmergedBranches(repoPath);
      const combined = [...new Set([...remote, ...local])].slice(0, 10); // Top 10 unique
      setBranchSuggestions(combined);

      // Also load all branches for base branch selector
      const [localAll, remoteAll] = await Promise.all([
        getLocalBranches(repoPath),
        getRemoteBranches(repoPath)
      ]);
      setAllBranches([...new Set([...remoteAll, ...localAll])]);
    } catch (error) {
      console.error('Failed to load branches:', error);
    } finally {
      setIsLoadingSuggestions(false);
    }
  }

  // Check if branch exists when name changes
  const checkBranchExistence = useCallback(async (name: string) => {
    if (!name.trim() || !repoPath) {
      setShowBaseBranchSelector(false);
      return;
    }

    setIsCheckingBranch(true);
    try {
      const exists = await checkBranchExists(repoPath, name);
      setShowBaseBranchSelector(!exists.local && !exists.remote);
    } catch (error) {
      console.error('Failed to check branch:', error);
      setShowBaseBranchSelector(false);
    } finally {
      setIsCheckingBranch(false);
    }
  }, [repoPath]);

  // Debounced branch name change handler
  useEffect(() => {
    const timer = setTimeout(() => {
      checkBranchExistence(branchName);
    }, 500);

    return () => clearTimeout(timer);
  }, [branchName, checkBranchExistence]);

  // Debounced Notion URL fetcher
  useEffect(() => {
    if (!notionUrl.trim()) {
      setSelectedNotionTask(null);
      setNotionPageError(null);
      setIsLoadingNotionPage(false);
      return;
    }

    const pageId = extractNotionPageId(notionUrl);
    if (!pageId) {
      // Don't show error while user is still typing
      if (notionUrl.includes('notion.so') || notionUrl.includes('notion.site')) {
        setNotionPageError('Invalid Notion URL format');
      }
      setSelectedNotionTask(null);
      setIsLoadingNotionPage(false);
      return;
    }

    // Immediately set branch name from URL slug (instant feedback)
    const slug = extractSlugFromNotionUrl(notionUrl);
    if (slug) {
      setBranchName(slug);
    }

    setIsLoadingNotionPage(true);
    setNotionPageError(null);

    const timer = setTimeout(async () => {
      try {
        const result = await fetchNotionPageByUrl(notionUrl);
        if (result.success && result.task) {
          setSelectedNotionTask(result.task);
          setBranchName(result.task.branchName);
          setNotionPageError(null);
        } else {
          setSelectedNotionTask(null);
          setNotionPageError(result.error || 'Failed to fetch page');
        }
      } catch (error) {
        setSelectedNotionTask(null);
        setNotionPageError(error instanceof Error ? error.message : 'Unknown error');
      } finally {
        setIsLoadingNotionPage(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [notionUrl]);

  async function handleSubmit(values: FormValues) {
    if (!values.worktreeName.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Worktree name required',
        message: 'Please enter a name for the worktree',
      });
      return;
    }

    if (!values.repoPath.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Repository path required',
        message: 'Please enter the path to the repository',
      });
      return;
    }

    // If user provided a Notion URL but fetch failed/hasn't completed, retry now
    let notionTask = selectedNotionTask;
    if (!notionTask && notionUrl.trim() && extractNotionPageId(notionUrl)) {
      try {
        const result = await fetchNotionPageByUrl(notionUrl);
        if (result.success && result.task) {
          notionTask = result.task;
          setSelectedNotionTask(result.task);
        }
      } catch (error) {
        console.error('Failed to fetch Notion page at submit:', error);
      }
    }

    // Start worktree creation with toast-based progress updates
    // This runs in the background and shows progress via animated toast
    startWorktreeCreation(
      values.worktreeName,
      values.repoPath,
      values.baseBranch,
      false,
      values.createOwnUpstream,
      notionTask
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Worktree" onSubmit={handleSubmit} />
          <Action
            title="Refresh Branches"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ['cmd'], key: 'r' }}
            onAction={async () => {
              await showToast({
                style: Toast.Style.Animated,
                title: 'Fetching branches...',
              });
              try {
                // Fetch from remote
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                await execAsync(`/usr/bin/git -C "${repoPath}" fetch origin`);

                await loadBranchSuggestions();

                await showToast({
                  style: Toast.Style.Success,
                  title: 'Branches refreshed',
                });
              } catch (error) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: 'Failed to refresh branches',
                  message: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }}
          />
          <Action.Push
            title="Create Notion Task"
            icon={Icon.Plus}
            shortcut={{ modifiers: ['cmd'], key: 'n' }}
            target={
              <CreateNotionTaskForm
                onTaskCreated={(task) => {
                  // Set the URL field to the created task's URL
                  setNotionUrl(task.url);
                  setBranchName(task.branchName);
                  setSelectedNotionTask(task);
                }}
              />
            }
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="worktreeName"
        title="Branch Name"
        placeholder="bug-fix-123 or feature-name"
        info="Type a new branch name or select from suggestions below"
        value={branchName}
        onChange={(value) => {
          setBranchName(value);
        }}
      />

      <Form.TextField
        id="notionUrl"
        title="Notion Task URL"
        placeholder="https://notion.so/..."
        info="Paste a Notion task URL to auto-populate branch name and create a brief"
        value={notionUrl}
        onChange={setNotionUrl}
      />

      {isLoadingNotionPage && (
        <Form.Description text="Loading Notion task..." />
      )}

      {notionPageError && (
        <Form.Description text={`Error: ${notionPageError}`} />
      )}

      {selectedNotionTask && !isLoadingNotionPage && (
        <Form.Description
          title="Notion Task"
          text={`${selectedNotionTask.taskId ? selectedNotionTask.taskId + ': ' : ''}${selectedNotionTask.title} [${selectedNotionTask.status}]`}
        />
      )}

      {branchSuggestions.length > 0 && (
        <Form.Dropdown
          id="branchSuggestion"
          title="Unmerged Branches"
          info="Select a branch to prepopulate the field above"
          value=""
          onChange={(selectedBranch) => {
            if (selectedBranch) {
              setBranchName(selectedBranch);
            }
          }}
        >
          <Form.Dropdown.Item value="" title={isLoadingSuggestions ? 'Loading...' : 'Select a branch...'} />
          {branchSuggestions.map((branch) => (
            <Form.Dropdown.Item key={branch} value={branch} title={branch} />
          ))}
        </Form.Dropdown>
      )}

      {showBaseBranchSelector && (
        <Form.Dropdown
          id="baseBranch"
          title="Branch From"
          info="Select the base branch to create the new branch from"
          defaultValue="main"
        >
          <Form.Dropdown.Item value="main" title="main" />
          {allBranches
            .filter((b) => b !== 'main')
            .map((branch) => (
              <Form.Dropdown.Item key={branch} value={branch} title={branch} />
            ))}
        </Form.Dropdown>
      )}

      {showBaseBranchSelector && (
        <Form.Checkbox
          id="createOwnUpstream"
          label="Create own upstream branch"
          info="When enabled, creates its own upstream branch that merges via PR. When disabled, the upstream is set to the base branch."
          defaultValue={true}
        />
      )}

      {isCheckingBranch && (
        <Form.Description
          text="Checking if branch exists..."
        />
      )}

      <Form.TextField
        id="repoPath"
        title="Repository Path"
        placeholder="/Users/username/Code/repo"
        value={repoPath}
        onChange={setRepoPath}
        info="The path to the git repository where the worktree will be created"
      />
    </Form>
  );
}
