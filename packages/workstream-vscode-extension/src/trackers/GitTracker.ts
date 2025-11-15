import * as vscode from 'vscode';
import { RedisPublisher } from '../RedisPublisher';
import { StateManager } from '../StateManager';

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
}

interface RepositoryState {
  HEAD: Branch | undefined;
  onDidChange: vscode.Event<void>;
}

interface Branch {
  name: string | undefined;
  commit: string | undefined;
}

export class GitTracker {
  private disposables: vscode.Disposable[] = [];
  private gitAPI: GitAPI | null = null;
  private currentBranch: string | undefined;

  constructor(
    private readonly publisher: RedisPublisher,
    private readonly stateManager: StateManager
  ) {}

  async start(): Promise<void> {
    // Try to get Git extension
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      console.log('[Workstream] Git extension not found');
      return;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    this.gitAPI = gitExtension.exports.getAPI(1);

    // Track existing repositories
    for (const repo of this.gitAPI.repositories) {
      this.trackRepository(repo);
    }

    // Track new repositories
    this.disposables.push(
      this.gitAPI.onDidOpenRepository((repo) => {
        this.trackRepository(repo);
      })
    );
  }

  private trackRepository(repo: Repository): void {
    // Initialize current branch
    if (repo.state.HEAD?.name) {
      this.currentBranch = repo.state.HEAD.name;
      this.stateManager.gitState.branch = this.currentBranch;
    }

    // Track branch changes
    this.disposables.push(
      repo.state.onDidChange(() => {
        const newBranch = repo.state.HEAD?.name;

        // Detect branch checkout
        if (newBranch && newBranch !== this.currentBranch) {
          const oldBranch = this.currentBranch;
          this.currentBranch = newBranch;
          this.stateManager.gitState.branch = newBranch;
          this.stateManager.gitState.lastCheckout = {
            branch: newBranch,
            timestamp: Date.now(),
          };

          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            this.publisher.publishEvent('workstream:vscode:git', {
              type: 'branch-checkout',
              workspacePath: workspaceFolder.uri.fsPath,
              timestamp: Date.now(),
              data: {
                from: oldBranch,
                to: newBranch,
              },
            });
          }
        }

        // Detect commit (HEAD commit changed but branch name stayed the same)
        const newCommit = repo.state.HEAD?.commit;
        if (newCommit && newBranch === this.currentBranch) {
          this.stateManager.gitState.lastCommit = {
            timestamp: Date.now(),
          };

          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            this.publisher.publishEvent('workstream:vscode:git', {
              type: 'commit',
              workspacePath: workspaceFolder.uri.fsPath,
              timestamp: Date.now(),
              data: {
                branch: newBranch,
                commit: newCommit,
              },
            });
          }
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
