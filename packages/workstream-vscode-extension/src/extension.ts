import * as vscode from 'vscode';
import Redis from 'ioredis';
import { RedisPublisher } from './RedisPublisher';
import { StateManager } from './StateManager';
import { WorkspaceTracker } from './trackers/WorkspaceTracker';
import { FileTracker } from './trackers/FileTracker';
import { GitTracker } from './trackers/GitTracker';
import { TerminalTracker } from './trackers/TerminalTracker';
import { Config } from './config';

let publisher: RedisPublisher | null = null;
let stateManager: StateManager | null = null;
let subscriber: Redis | null = null;
let trackers: {
  workspace?: WorkspaceTracker;
  file?: FileTracker;
  git?: GitTracker;
  terminal?: TerminalTracker;
} = {};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Workstream] Extension activating...');

  // Check if we have a workspace
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    console.log('[Workstream] No workspace folder found, extension will not activate');
    return;
  }

  // Check if extension is enabled
  if (!Config.enabled) {
    console.log('[Workstream] Extension is disabled in settings');
    return;
  }

  try {
    // Get extension version from package.json
    const extensionVersion = context.extension.packageJSON.version as string;

    // Initialize Redis publisher
    publisher = new RedisPublisher();
    await publisher.connect();

    // Initialize state manager
    stateManager = new StateManager(publisher, extensionVersion);

    // Initialize trackers
    trackers.workspace = new WorkspaceTracker(publisher, stateManager);
    trackers.file = new FileTracker(publisher, stateManager);
    trackers.git = new GitTracker(publisher, stateManager);
    trackers.terminal = new TerminalTracker(publisher, stateManager);

    // Start all trackers
    trackers.workspace.start();
    trackers.file.start();
    await trackers.git.start();
    await trackers.terminal.start();

    // Start state manager heartbeat
    stateManager.start();

    // Subscribe to terminal focus requests
    await setupTerminalFocusListener(context);

    // Register cleanup
    context.subscriptions.push({
      dispose: () => {
        console.log('[Workstream] Extension deactivating...');
        stateManager?.dispose();
        Object.values(trackers).forEach((tracker) => tracker?.dispose());
        publisher?.dispose();
        subscriber?.quit();
      },
    });

    console.log('[Workstream] Extension activated successfully');
  } catch (error) {
    console.error('[Workstream] Failed to activate extension:', error);
    vscode.window.showErrorMessage(`Workstream extension failed to activate: ${error}`);
  }
}

async function setupTerminalFocusListener(context: vscode.ExtensionContext): Promise<void> {
  try {
    subscriber = new Redis({
      host: Config.redisHost,
      port: Config.redisPort,
      maxRetriesPerRequest: 3,
    });

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) return;

    const workspaceBase64 = Buffer.from(workspacePath).toString('base64');

    // Subscribe to terminal focus channel for this workspace
    const focusChannel = `workstream:terminal:focus:${workspaceBase64}`;
    await subscriber.subscribe(focusChannel);

    // Subscribe to terminal creation channel for this workspace
    const createChannel = `workstream:terminal:create:${workspaceBase64}`;
    await subscriber.subscribe(createChannel);

    subscriber.on('message', async (receivedChannel, message) => {
      if (receivedChannel === focusChannel) {
        try {
          const { terminalPid } = JSON.parse(message) as { terminalPid: number };
          console.log(`[Workstream] Received terminal focus request for PID ${terminalPid}`);
          await focusTerminalByPid(terminalPid);
        } catch (error) {
          console.error('[Workstream] Failed to parse terminal focus message:', error);
        }
      } else if (receivedChannel === createChannel) {
        try {
          const { command, terminalName } = JSON.parse(message) as { command: string; terminalName?: string };
          console.log(`[Workstream] Received terminal creation request: ${command}`);
          await createAndRunTerminal(command, terminalName, workspacePath);
        } catch (error) {
          console.error('[Workstream] Failed to parse terminal creation message:', error);
        }
      }
    });

    console.log(`[Workstream] Listening for terminal requests on ${focusChannel} and ${createChannel}`);
  } catch (error) {
    console.error('[Workstream] Failed to setup terminal listeners:', error);
  }
}

async function focusTerminalByPid(pid: number): Promise<void> {
  if (!trackers.terminal) {
    console.warn('[Workstream] Terminal tracker not available');
    return;
  }

  const terminal = await trackers.terminal.getTerminalByPid(pid);
  if (terminal) {
    terminal.show(false); // false = focus the terminal (don't preserve focus elsewhere)
    console.log(`[Workstream] Focused terminal with PID ${pid}`);
  } else {
    console.warn(`[Workstream] Terminal with PID ${pid} not found`);
  }
}

async function createAndRunTerminal(command: string, terminalName: string | undefined, cwd: string): Promise<void> {
  try {
    // Create a new terminal with the specified name and working directory
    const terminal = vscode.window.createTerminal({
      name: terminalName || 'Claude',
      cwd: cwd
    });

    // Send the command to the terminal
    terminal.sendText(command);

    // Show and focus the terminal
    terminal.show(false); // false = focus the terminal

    console.log(`[Workstream] Created terminal "${terminalName || 'Claude'}" and executed: ${command}`);
  } catch (error) {
    console.error('[Workstream] Failed to create terminal:', error);
    vscode.window.showErrorMessage(`Failed to create Claude terminal: ${error}`);
  }
}

export function deactivate(): void {
  console.log('[Workstream] Extension deactivated');
}
