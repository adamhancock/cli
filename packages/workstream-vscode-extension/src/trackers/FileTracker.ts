import * as vscode from 'vscode';
import { RedisPublisher } from '../RedisPublisher';
import { StateManager } from '../StateManager';

export class FileTracker {
  private disposables: vscode.Disposable[] = [];
  private saveTimestamps: number[] = [];
  private readonly SAVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly publisher: RedisPublisher,
    private readonly stateManager: StateManager
  ) {}

  start(): void {
    // Track file saves
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        const now = Date.now();
        this.saveTimestamps.push(now);
        this.cleanOldSaveTimestamps(now);

        this.stateManager.fileActivityState.lastSave = now;
        this.stateManager.fileActivityState.savesLast5Min = this.saveTimestamps.length;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          this.publisher.publishEvent('workstream:vscode:file', {
            type: 'file-saved',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: now,
            data: {
              fileName: document.fileName,
              languageId: document.languageId,
            },
          });
        }
      })
    );

    // Track file opens
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && !document.isUntitled) {
          this.publisher.publishEvent('workstream:vscode:file', {
            type: 'file-opened',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: Date.now(),
            data: {
              fileName: document.fileName,
              languageId: document.languageId,
            },
          });
        }
      })
    );

    // Track active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.stateManager.fileActivityState.activeFile = editor.document.fileName;
        } else {
          this.stateManager.fileActivityState.activeFile = undefined;
        }
      })
    );

    // Track text document changes to count dirty files
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        const dirtyCount = vscode.workspace.textDocuments.filter((doc) => doc.isDirty).length;
        this.stateManager.fileActivityState.dirtyFileCount = dirtyCount;
      })
    );

    // Initialize active file
    if (vscode.window.activeTextEditor) {
      this.stateManager.fileActivityState.activeFile = vscode.window.activeTextEditor.document.fileName;
    }

    // Initialize dirty file count
    const dirtyCount = vscode.workspace.textDocuments.filter((doc) => doc.isDirty).length;
    this.stateManager.fileActivityState.dirtyFileCount = dirtyCount;

    // Clean old save timestamps periodically
    setInterval(() => {
      this.cleanOldSaveTimestamps(Date.now());
      this.stateManager.fileActivityState.savesLast5Min = this.saveTimestamps.length;
    }, 60000); // Every minute
  }

  private cleanOldSaveTimestamps(now: number): void {
    const cutoff = now - this.SAVE_WINDOW_MS;
    this.saveTimestamps = this.saveTimestamps.filter((ts) => ts > cutoff);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
