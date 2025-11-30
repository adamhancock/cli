import * as vscode from 'vscode';
import Redis from 'ioredis';
import { WorktreeUpdate } from '../types';

const WORKTREE_UPDATES_CHANNEL = 'workstream:worktree:updates';

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
  if (lastLine.includes('Detected')) return 'Installing dependencies...';

  // Return a truncated version of the last line if no match
  return lastLine.length > 40 ? lastLine.substring(0, 37) + '...' : lastLine || 'Starting...';
}

export class WorktreeProgressTracker {
  private statusBarItem: vscode.StatusBarItem;
  private isSubscribed = false;
  private activeJobId: string | null = null;
  private outputBuffer = '';
  private hideTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly subscriber: Redis) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      0
    );
  }

  async start(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      console.log('[Workstream] WorktreeProgressTracker: No workspace folder, not starting');
      return;
    }

    try {
      // Subscribe to worktree updates channel
      await this.subscriber.subscribe(WORKTREE_UPDATES_CHANNEL);
      this.isSubscribed = true;

      this.subscriber.on('message', (channel, message) => {
        if (channel === WORKTREE_UPDATES_CHANNEL) {
          this.handleWorktreeUpdate(message, workspacePath);
        }
      });

      console.log(`[Workstream] WorktreeProgressTracker: Listening for worktree updates`);
    } catch (error) {
      console.error('[Workstream] WorktreeProgressTracker: Failed to subscribe:', error);
    }
  }

  private handleWorktreeUpdate(message: string, workspacePath: string): void {
    try {
      const update = JSON.parse(message) as WorktreeUpdate;

      // Check if this update is relevant to our workspace
      if (!this.isRelevantUpdate(update, workspacePath)) {
        return;
      }

      console.log(`[Workstream] WorktreeProgressTracker: Received relevant update for job ${update.jobId}, status: ${update.status}`);

      switch (update.status) {
        case 'running':
          this.showProgress(update);
          break;
        case 'completed':
          this.showSuccess(update);
          break;
        case 'failed':
          this.showFailure(update);
          break;
        case 'skipped':
          this.showSkipped(update);
          break;
      }
    } catch (error) {
      console.error('[Workstream] WorktreeProgressTracker: Failed to parse update:', error);
    }
  }

  private isRelevantUpdate(update: WorktreeUpdate, workspacePath: string): boolean {
    // If we're already tracking a job, continue tracking it
    if (this.activeJobId && this.activeJobId === update.jobId) {
      return true;
    }

    // Match by worktreePath if available
    if (update.worktreePath && update.worktreePath === workspacePath) {
      this.activeJobId = update.jobId;
      return true;
    }

    // Match if workspace is within repoPath (for worktrees created from a parent repo)
    if (update.repoPath && workspacePath.startsWith(update.repoPath)) {
      // Additional check: workspace should be a sibling of repoPath with matching branch name
      // e.g., repoPath=/Users/adam/Code/cli, workspacePath=/Users/adam/Code/cli-feature-branch
      const parentDir = update.repoPath.substring(0, update.repoPath.lastIndexOf('/'));
      if (workspacePath.startsWith(parentDir) && update.worktreeName) {
        const workspaceName = workspacePath.split('/').pop() || '';
        const repoName = update.repoPath.split('/').pop() || '';
        const expectedName = `${repoName}-${update.worktreeName.replace(/\//g, '-')}`;
        if (workspaceName === expectedName) {
          this.activeJobId = update.jobId;
          return true;
        }
      }
    }

    // For new 'running' status updates, try to match based on workspace path pattern
    if (update.status === 'running' && update.worktreeName) {
      const workspaceName = workspacePath.split('/').pop() || '';
      const safeWorktreeName = update.worktreeName.replace(/\//g, '-');
      if (workspaceName.endsWith(safeWorktreeName)) {
        this.activeJobId = update.jobId;
        return true;
      }
    }

    return false;
  }

  private showProgress(update: WorktreeUpdate): void {
    // Clear any existing hide timeout
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    // Accumulate output
    if (update.output) {
      this.outputBuffer += update.output;
    }

    const statusMessage = parseStatusMessage(this.outputBuffer);

    this.statusBarItem.text = `$(sync~spin) ${statusMessage}`;
    this.statusBarItem.tooltip = `Worktree setup in progress...\n\nJob: ${update.jobId}\n\nClick to dismiss`;
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.command = {
      command: 'workstream.dismissWorktreeProgress',
      title: 'Dismiss',
    };
    this.statusBarItem.show();
  }

  private showSuccess(update: WorktreeUpdate): void {
    this.statusBarItem.text = '$(check) Worktree ready';
    this.statusBarItem.tooltip = `Worktree setup completed successfully\n\nPath: ${update.worktreePath || 'Unknown'}`;
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.command = undefined;
    this.statusBarItem.show();

    // Hide after 5 seconds
    this.scheduleHide(5000);

    // Reset state
    this.activeJobId = null;
    this.outputBuffer = '';
  }

  private showFailure(update: WorktreeUpdate): void {
    this.statusBarItem.text = '$(error) Worktree failed';
    this.statusBarItem.tooltip = `Worktree creation failed\n\nError: ${update.error || 'Unknown error'}\n\nClick to dismiss`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.statusBarItem.command = {
      command: 'workstream.dismissWorktreeProgress',
      title: 'Dismiss',
    };
    this.statusBarItem.show();

    // Show error notification
    vscode.window.showErrorMessage(`Worktree creation failed: ${update.error || 'Unknown error'}`);

    // Hide after 10 seconds
    this.scheduleHide(10000);

    // Reset state
    this.activeJobId = null;
    this.outputBuffer = '';
  }

  private showSkipped(update: WorktreeUpdate): void {
    this.statusBarItem.text = '$(warning) Worktree skipped';
    this.statusBarItem.tooltip = 'Worktree creation was skipped (already in progress)';
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.statusBarItem.command = undefined;
    this.statusBarItem.show();

    // Hide after 5 seconds
    this.scheduleHide(5000);

    // Reset state
    this.activeJobId = null;
    this.outputBuffer = '';
  }

  private scheduleHide(ms: number): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }
    this.hideTimeout = setTimeout(() => {
      this.statusBarItem.hide();
      this.hideTimeout = null;
    }, ms);
  }

  /**
   * Manually dismiss the status bar item
   */
  dismiss(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.statusBarItem.hide();
    this.activeJobId = null;
    this.outputBuffer = '';
  }

  dispose(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }
    this.statusBarItem.dispose();
    // Note: We don't unsubscribe from Redis here as the subscriber is shared
  }
}
