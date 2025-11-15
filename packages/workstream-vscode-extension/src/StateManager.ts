import * as vscode from 'vscode';
import { RedisPublisher } from './RedisPublisher';
import { VSCodeState } from './types';
import { Config } from './config';

export class StateManager {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private extensionVersion: string;

  // State from trackers (will be updated by them)
  public windowFocused = true;
  public terminalState = {
    total: 0,
    active: 0,
    pids: [] as number[],
    names: [] as string[],
    purposes: { devServer: 0, testing: 0, build: 0, general: 0 },
  };
  public debugState = {
    active: false,
    sessionCount: 0,
    types: [] as string[],
  };
  public fileActivityState = {
    lastSave: 0,
    savesLast5Min: 0,
    activeFile: undefined as string | undefined,
    dirtyFileCount: 0,
  };
  public gitState = {
    branch: undefined as string | undefined,
    lastCheckout: undefined as { branch: string; timestamp: number } | undefined,
    lastCommit: undefined as { timestamp: number } | undefined,
  };

  constructor(
    private readonly publisher: RedisPublisher,
    extensionVersion: string
  ) {
    this.extensionVersion = extensionVersion;
  }

  start(): void {
    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.publishState();
    }, Config.heartbeatInterval);

    // Publish initial state
    this.publishState();
  }

  /**
   * Publish state immediately (bypassing heartbeat interval).
   * Use this when you need to reflect state changes instantly (e.g., window focus changes).
   */
  async publishStateImmediately(): Promise<void> {
    await this.publishState();
  }

  private async publishState(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const state: VSCodeState = {
      workspacePath: workspaceFolder.uri.fsPath,
      extensionVersion: this.extensionVersion,
      vscodeVersion: vscode.version,
      vscodePid: process.pid,

      window: {
        focused: this.windowFocused,
      },

      terminals: this.terminalState,
      debug: this.debugState,
      fileActivity: this.fileActivityState,
      git: this.gitState,

      lastUpdated: Date.now(),
    };

    await this.publisher.publishState(workspaceFolder.uri.fsPath, state);
  }

  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
