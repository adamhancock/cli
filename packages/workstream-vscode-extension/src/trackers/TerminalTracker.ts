import * as vscode from 'vscode';
import { RedisPublisher } from '../RedisPublisher';
import { StateManager } from '../StateManager';
import { TerminalInfo, TerminalPurpose } from '../types';
import { findClaudeProcess } from '../utils/processDetection';

interface ClaudeTerminalInfo {
  claudePid: number;
  terminalName: string;  // VSCode terminal name (e.g., "bash", "zsh", "Terminal 1")
  terminalPid: number;
  vscodePid: number;
  refreshInterval?: NodeJS.Timeout;
}

export class TerminalTracker {
  private disposables: vscode.Disposable[] = [];
  private terminals = new Map<number, TerminalInfo>();
  private terminalToId = new WeakMap<vscode.Terminal, number>();
  private nextId = 1;
  private claudeTerminals = new Map<number, ClaudeTerminalInfo>();

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

    // Track shell integration for Claude detection
    this.disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration(async (event) => {
        const terminal = event.terminal;
        const shellIntegration = event.shellIntegration;

        if (shellIntegration) {
          // Listen for command execution
          const executeCommandDisposable = shellIntegration.executeCommand.event(async (execution) => {
            const commandLine = execution.commandLine.value;

            // Check if this is a Claude command
            if (/^(clauded|claude-code|claude)\s/.test(commandLine)) {
              await this.onClaudeCommandDetected(terminal);
            }
          });

          this.disposables.push(executeCommandDisposable);
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

  /**
   * Called when Claude command is detected in a terminal
   */
  private async onClaudeCommandDetected(terminal: vscode.Terminal): Promise<void> {
    console.log('[Workstream] Claude command detected in terminal:', terminal.name);

    // Get terminal PID
    const terminalPid = await terminal.processId;
    if (!terminalPid) {
      console.warn('[Workstream] Could not get terminal PID');
      return;
    }

    // Wait a bit for Claude process to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find Claude process under this shell
    const claudePid = await findClaudeProcess(terminalPid);
    if (!claudePid) {
      console.warn('[Workstream] Could not find Claude process under terminal PID', terminalPid);
      return;
    }

    console.log('[Workstream] Found Claude process:', claudePid);

    // Get VSCode PID
    const vscodePid = process.pid;

    // Get workspace path for terminal ID
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    // Get terminal ID from our internal tracking
    const id = this.terminalToId.get(terminal);
    const termInfo = id !== undefined ? this.terminals.get(id) : undefined;

    // Use VSCode terminal name for the terminal ID
    const terminalName = terminal.name;

    // Register Claude terminal
    await this.registerClaudeTerminal(claudePid, terminalName, terminalPid, vscodePid, workspaceFolder.uri.fsPath);
  }

  /**
   * Register a Claude terminal to Redis
   */
  private async registerClaudeTerminal(
    claudePid: number,
    terminalName: string,
    terminalPid: number,
    vscodePid: number,
    workspace: string
  ): Promise<void> {
    console.log(`[Workstream] Registering Claude terminal: Claude PID=${claudePid}, Terminal="${terminalName}"`);

    const info: ClaudeTerminalInfo = {
      claudePid,
      terminalName,
      terminalPid,
      vscodePid,
    };

    // Store the Claude terminal context in Redis
    const redisKey = `claude:terminal:${claudePid}`;
    // Include both terminalName (for display) and terminalId (for matching with zsh plugin)
    const terminalId = `vscode-${vscodePid}-${terminalPid}`;
    const context = JSON.stringify({
      terminalName,
      terminalId,
      terminalPid,
      vscodePid,
      workspace,
    });

    // Set with 60s TTL and refresh every 30s
    await this.publisher.setKey(redisKey, context, 60);

    // Set up auto-refresh
    const refreshInterval = setInterval(async () => {
      // Check if Claude process is still running
      // If not, clean up
      try {
        process.kill(claudePid, 0); // Signal 0 just checks if process exists
        // Still running, refresh TTL
        await this.publisher.setKey(redisKey, context, 60);
      } catch (error) {
        // Process no longer exists, clean up
        console.log(`[Workstream] Claude process ${claudePid} no longer exists, cleaning up`);
        await this.cleanupClaudeTerminal(claudePid);
      }
    }, 30000); // Every 30 seconds

    info.refreshInterval = refreshInterval;
    this.claudeTerminals.set(claudePid, info);

    console.log(`[Workstream] Claude terminal registered successfully`);
  }

  /**
   * Clean up Claude terminal registration
   */
  private async cleanupClaudeTerminal(claudePid: number): Promise<void> {
    const info = this.claudeTerminals.get(claudePid);
    if (!info) {
      return;
    }

    console.log(`[Workstream] Cleaning up Claude terminal: PID=${claudePid}`);

    // Stop refresh interval
    if (info.refreshInterval) {
      clearInterval(info.refreshInterval);
    }

    // Delete Redis key
    const redisKey = `claude:terminal:${claudePid}`;
    await this.publisher.deleteKey(redisKey);

    // Remove from tracking
    this.claudeTerminals.delete(claudePid);
  }

  dispose(): void {
    // Clean up all Claude terminals
    for (const [claudePid, info] of this.claudeTerminals.entries()) {
      if (info.refreshInterval) {
        clearInterval(info.refreshInterval);
      }
    }
    this.claudeTerminals.clear();

    // Dispose all listeners
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
