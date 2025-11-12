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
} from '@raycast/api';
import { useEffect, useState } from 'react';
import { createWorktreeStreaming, openWorktreeInVSCode } from './utils/worktree';
import { triggerDaemonRefresh } from './utils/daemon-client';
import { homedir } from 'os';
import { join } from 'path';

interface FormValues {
  worktreeName: string;
  repoPath: string;
}

function WorktreeOutput({
  worktreeName,
  repoPath,
}: {
  worktreeName: string;
  repoPath: string;
}) {
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(true);
  const [worktreePath, setWorktreePath] = useState<string | undefined>();
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function runWorktree() {
      const result = await createWorktreeStreaming(
        worktreeName,
        { repoPath },
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
  }, [worktreeName, repoPath]);

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

  return (
    <Detail
      markdown={markdown}
      actions={
        !isRunning ? (
          <ActionPanel>
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
    push(<WorktreeOutput worktreeName={values.worktreeName} repoPath={values.repoPath} />);
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Worktree" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="worktreeName"
        title="Worktree Name"
        placeholder="bug-fix-123 or feature-name"
        info="The name for your new worktree (spaces will be converted to dashes)"
      />
      <Form.TextField
        id="repoPath"
        title="Repository Path"
        placeholder="/Users/username/Code/repo"
        defaultValue={join(homedir(), 'Code', 'assurix')}
        info="The path to the git repository where the worktree will be created"
      />
    </Form>
  );
}
