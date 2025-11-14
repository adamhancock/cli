import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  closeMainWindow,
  popToRoot,
  Detail,
  useNavigation,
  Icon,
  getPreferenceValues,
} from '@raycast/api';
import { useEffect, useState, useCallback } from 'react';
import { createWorktreeStreaming, openWorktreeInVSCode } from './utils/worktree';
import { triggerDaemonRefresh } from './utils/daemon-client';
import { getUnmergedBranches, branchExists as checkBranchExists, getLocalBranches, getRemoteBranches } from './utils/git';
import { homedir } from 'os';
import { join } from 'path';

interface Preferences {
  defaultRepoPath?: string;
  devDomain?: string;
}

interface FormValues {
  worktreeName: string;
  repoPath: string;
  baseBranch?: string;
}

function WorktreeOutput({
  worktreeName,
  repoPath,
  baseBranch,
  force,
}: {
  worktreeName: string;
  repoPath: string;
  baseBranch?: string;
  force?: boolean;
}) {
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(true);
  const [worktreePath, setWorktreePath] = useState<string | undefined>();
  const [success, setSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;

    async function runWorktree() {
      const result = await createWorktreeStreaming(
        worktreeName,
        { repoPath, baseBranch, force },
        (chunk) => {
          if (mounted) {
            setOutput((prev) => prev + chunk);
          }
        }
      );

      if (mounted) {
        setIsRunning(false);
        setSuccess(result.success);
        setWorktreePath(result.worktreePath);
        setErrorMessage(result.error);

        if (result.success) {
          await showToast({
            style: Toast.Style.Success,
            title: 'Worktree created successfully',
          });

          // Automatically open VS Code
          if (result.worktreePath) {
            try {
              await openWorktreeInVSCode(result.worktreePath);

              // Trigger daemon to refresh and pick up the new VS Code instance
              await triggerDaemonRefresh();

              // Wait a bit for VS Code to open, then close Raycast
              setTimeout(async () => {
                await closeMainWindow();
                await popToRoot();
              }, 1000);
            } catch (error) {
              console.error('Failed to open VS Code:', error);
              // Don't show toast error here, just log it
            }
          }
        } else {
          await showToast({
            style: Toast.Style.Failure,
            title: 'Failed to create worktree',
          });
        }
      }
    }

    runWorktree();

    return () => {
      mounted = false;
    };
  }, [worktreeName, repoPath, baseBranch, force]);

  // Keep only the last 200 lines to auto-scroll to latest output
  const outputLines = output.split('\n');
  const displayOutput = isRunning && outputLines.length > 200
    ? outputLines.slice(-200).join('\n')
    : output;

  const statusText = isRunning
    ? '⏳ Creating'
    : success
      ? '✅ Created - Opening VS Code...'
      : '❌ Failed';

  const markdown = `# ${statusText} Worktree: ${worktreeName}\n\n\`\`\`\n${displayOutput || 'Starting...'}\n${isRunning ? '\n⏳ Working...' : ''}\n\`\`\``;

  const { push } = useNavigation();
  const isDirectoryExistsError = errorMessage?.includes('already exists');

  return (
    <Detail
      markdown={markdown}
      actions={
        !isRunning ? (
          <ActionPanel>
            {!success && isDirectoryExistsError && (
              <Action
                title="Remove and Recreate"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => {
                  push(
                    <WorktreeOutput
                      worktreeName={worktreeName}
                      repoPath={repoPath}
                      baseBranch={baseBranch}
                      force={true}
                    />
                  );
                }}
              />
            )}
            {!success && (
              <Action
                title="Retry"
                icon={Icon.ArrowClockwise}
                onAction={() => {
                  push(
                    <WorktreeOutput
                      worktreeName={worktreeName}
                      repoPath={repoPath}
                      baseBranch={baseBranch}
                    />
                  );
                }}
              />
            )}
            {worktreePath && (
              <Action
                title="Open in VS Code"
                onAction={async () => {
                  try {
                    await openWorktreeInVSCode(worktreePath);
                    await closeMainWindow();
                    await popToRoot();
                  } catch (error) {
                    await showToast({
                      style: Toast.Style.Failure,
                      title: 'Failed to open VS Code',
                      message: error instanceof Error ? error.message : 'Unknown error',
                    });
                  }
                }}
              />
            )}
            <Action.CopyToClipboard title="Copy Output" content={output} />
            {worktreePath && <Action.CopyToClipboard title="Copy Path" content={worktreePath} />}
            <Action
              title="Close"
              onAction={async () => {
                await closeMainWindow();
                await popToRoot();
              }}
            />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}

export default function CreateWorktreeCommand() {
  const { push } = useNavigation();
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

    // Immediately navigate to output view which will start the process
    push(
      <WorktreeOutput
        worktreeName={values.worktreeName}
        repoPath={values.repoPath}
        baseBranch={values.baseBranch}
      />
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
