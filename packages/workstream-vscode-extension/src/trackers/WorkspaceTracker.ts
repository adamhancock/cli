import * as vscode from 'vscode';
import { RedisPublisher } from '../RedisPublisher';
import { StateManager } from '../StateManager';

export class WorkspaceTracker {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly publisher: RedisPublisher,
    private readonly stateManager: StateManager
  ) {}

  start(): void {
    // Track window focus changes
    this.disposables.push(
      vscode.window.onDidChangeWindowState(async (e) => {
        this.stateManager.windowFocused = e.focused;

        // Publish state immediately to reflect focus change in real-time
        await this.stateManager.publishStateImmediately();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          this.publisher.publishEvent('workstream:vscode:workspace', {
            type: 'window-state-changed',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: Date.now(),
            data: { focused: e.focused },
          });
        }
      })
    );

    // Track workspace folder changes
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          this.publisher.publishEvent('workstream:vscode:workspace', {
            type: 'workspace-folders-changed',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: Date.now(),
            data: {
              added: e.added.length,
              removed: e.removed.length,
              totalFolders: vscode.workspace.workspaceFolders?.length || 0,
            },
          });
        }
      })
    );

    // Initialize window state
    this.stateManager.windowFocused = vscode.window.state.focused;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
