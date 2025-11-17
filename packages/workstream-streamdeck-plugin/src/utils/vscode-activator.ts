import { streamDeck } from '@elgato/streamdeck';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * VSCode bundle identifiers
 */
const VSCODE_BUNDLE_IDS = {
  stable: 'com.microsoft.VSCode',
  insiders: 'com.microsoft.VSCodeInsiders',
} as const;

/**
 * Focus a VSCode window by workspace path
 */
export async function focusVSCodeWindow(workspacePath: string): Promise<void> {
  try {
    streamDeck.logger.info(`Focusing VSCode window for: ${workspacePath}`);

    // First try to activate VSCode with the specific workspace
    // This uses the macOS `open` command which will:
    // 1. Open VSCode if it's not running
    // 2. Focus the VSCode window with this workspace if already open
    // 3. Open the workspace in a new window if not currently open
    const command = `open -a "Visual Studio Code" "${workspacePath}"`;

    await execAsync(command);

    streamDeck.logger.info(`Successfully focused VSCode window for: ${workspacePath}`);
  } catch (error) {
    streamDeck.logger.error(`Failed to focus VSCode window for ${workspacePath}:`, error);
    throw new Error(`Failed to focus VSCode window: ${error}`);
  }
}

/**
 * Check if VSCode is running
 */
export async function isVSCodeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to (name of processes) contains "Code"'`
    );

    return stdout.trim() === 'true';
  } catch (error) {
    streamDeck.logger.error('Failed to check if VSCode is running:', error);
    return false;
  }
}

/**
 * Alternative method using AppleScript for more reliable window activation
 * This can be used if the `open` command doesn't work reliably
 */
export async function focusVSCodeWindowWithAppleScript(workspacePath: string): Promise<void> {
  try {
    streamDeck.logger.info(`Focusing VSCode window with AppleScript for: ${workspacePath}`);

    // First open the workspace
    await execAsync(`open -a "Visual Studio Code" "${workspacePath}"`);

    // Then explicitly activate VSCode
    const script = `
      tell application "Visual Studio Code"
        activate
      end tell
    `;

    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);

    streamDeck.logger.info(`Successfully focused VSCode window for: ${workspacePath}`);
  } catch (error) {
    streamDeck.logger.error(`Failed to focus VSCode window with AppleScript for ${workspacePath}:`, error);
    throw new Error(`Failed to focus VSCode window: ${error}`);
  }
}
