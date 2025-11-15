import * as vscode from 'vscode';
import { RedisPublisher } from '../RedisPublisher';
import { StateManager } from '../StateManager';
import { TerminalInfo, TerminalPurpose } from '../types';

export class TerminalTracker {
  private disposables: vscode.Disposable[] = [];
  private terminals = new Map<number, TerminalInfo>();
  private terminalToId = new WeakMap<vscode.Terminal, number>();
  private nextId = 1;

  constructor(
    private readonly publisher: RedisPublisher,
    private readonly stateManager: StateManager
  ) {}

  async start(): Promise<void> {
    // Track existing terminals
    for (const terminal of vscode.window.terminals) {
      await this.onTerminalOpened(terminal);
    }

    // Track new terminals
    this.disposables.push(
      vscode.window.onDidOpenTerminal(async (terminal) => {
        await this.onTerminalOpened(terminal);
      })
    );

    // Track terminal closures
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.onTerminalClosed(terminal);
      })
    );

    // Track active terminal changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        this.updateActiveTerminal(terminal);
      })
    );

    // Track terminal state changes (interaction)
    this.disposables.push(
      vscode.window.onDidChangeTerminalState((terminal) => {
        const id = this.terminalToId.get(terminal);
        if (id !== undefined && this.terminals.has(id)) {
          const termInfo = this.terminals.get(id)!;
          termInfo.hasBeenInteractedWith = terminal.state.isInteractedWith;
        }
      })
    );

    // Track debug sessions
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.updateDebugState();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          this.publisher.publishEvent('workstream:vscode:terminal', {
            type: 'debug-started',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: Date.now(),
            data: {
              name: session.name,
              type: session.type,
            },
          });
        }
      })
    );

    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession(() => {
        this.updateDebugState();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          this.publisher.publishEvent('workstream:vscode:terminal', {
            type: 'debug-terminated',
            workspacePath: workspaceFolder.uri.fsPath,
            timestamp: Date.now(),
            data: {},
          });
        }
      })
    );

    // Initialize debug state
    this.updateDebugState();
  }

  /**
   * Get a terminal by its process ID
   */
  async getTerminalByPid(pid: number): Promise<vscode.Terminal | undefined> {
    console.log(`[Workstream] Looking for terminal with PID ${pid}`);
    console.log(`[Workstream] Total VSCode terminals: ${vscode.window.terminals.length}`);

    // Iterate through all VSCode terminals
    for (const terminal of vscode.window.terminals) {
      const id = this.terminalToId.get(terminal);
      if (id !== undefined) {
        const termInfo = this.terminals.get(id);
        console.log(`[Workstream] Checking terminal ID ${id}: PID=${termInfo?.pid}, Name="${termInfo?.name}"`);
        if (termInfo?.pid === pid) {
          console.log(`[Workstream] Found matching terminal: "${termInfo.name}"`);
          return terminal;
        }
      }
    }

    console.warn(`[Workstream] No terminal found with PID ${pid}`);
    return undefined;
  }

  private async onTerminalOpened(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    const id = this.nextId++;
    this.terminalToId.set(terminal, id);

    const termInfo: TerminalInfo = {
      pid,
      name: terminal.name,
      shellPath: terminal.creationOptions.shellPath as string | undefined,
      cwd: typeof terminal.creationOptions.cwd === 'string'
        ? terminal.creationOptions.cwd
        : terminal.creationOptions.cwd?.fsPath,
      createdAt: Date.now(),
      isActive: vscode.window.activeTerminal === terminal,
      hasBeenInteractedWith: terminal.state.isInteractedWith,
      purpose: this.inferPurpose(terminal.name),
    };

    this.terminals.set(id, termInfo);
    this.updateTerminalState();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      this.publisher.publishEvent('workstream:vscode:terminal', {
        type: 'terminal-opened',
        workspacePath: workspaceFolder.uri.fsPath,
        timestamp: Date.now(),
        data: {
          name: terminal.name,
          pid,
          purpose: termInfo.purpose,
        },
      });
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    const id = this.terminalToId.get(terminal);
    if (id === undefined || !this.terminals.has(id)) {
      return;
    }

    const termInfo = this.terminals.get(id)!;
    termInfo.closedAt = Date.now();
    termInfo.exitCode = terminal.exitStatus?.code;

    // Keep terminal in map for a bit, then remove
    setTimeout(() => {
      this.terminals.delete(id);
      this.updateTerminalState();
    }, 60000); // 1 minute

    this.updateTerminalState();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      this.publisher.publishEvent('workstream:vscode:terminal', {
        type: 'terminal-closed',
        workspacePath: workspaceFolder.uri.fsPath,
        timestamp: Date.now(),
        data: {
          name: terminal.name,
          exitCode: terminal.exitStatus?.code,
        },
      });
    }
  }

  private updateActiveTerminal(terminal: vscode.Terminal | undefined): void {
    // Mark all terminals as inactive
    for (const [, termInfo] of this.terminals) {
      termInfo.isActive = false;
    }

    // Mark active terminal
    if (terminal) {
      const id = this.terminalToId.get(terminal);
      if (id !== undefined && this.terminals.has(id)) {
        this.terminals.get(id)!.isActive = true;
      }
    }

    this.updateTerminalState();
  }

  private updateTerminalState(): void {
    const activeTerminals = Array.from(this.terminals.values()).filter(
      (t) => !t.closedAt
    );

    const purposes = {
      devServer: 0,
      testing: 0,
      build: 0,
      general: 0,
    };

    for (const term of activeTerminals) {
      purposes[term.purpose]++;
    }

    this.stateManager.terminalState = {
      total: activeTerminals.length,
      active: activeTerminals.filter((t) => t.isActive).length,
      pids: activeTerminals.map((t) => t.pid).filter((p): p is number => p !== undefined),
      names: activeTerminals.map((t) => t.name),
      purposes,
    };
  }

  private updateDebugState(): void {
    const sessions = vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : [];
    const sessionTypes = new Set(sessions.map((s) => s.type));

    this.stateManager.debugState = {
      active: sessions.length > 0,
      sessionCount: sessions.length,
      types: Array.from(sessionTypes),
    };
  }

  private inferPurpose(name: string): TerminalPurpose {
    const lower = name.toLowerCase();

    if (lower.includes('dev') || lower.includes('serve') || lower.includes('server')) {
      return 'dev-server';
    }
    if (lower.includes('test') || lower.includes('jest') || lower.includes('vitest') || lower.includes('pytest')) {
      return 'testing';
    }
    if (lower.includes('build') || lower.includes('watch') || lower.includes('compile')) {
      return 'build';
    }

    return 'general';
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
