import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export interface TmuxSessionInfo {
  name: string;
  exists: boolean;
  lastOutput?: string;
}

/**
 * Get tmux session information for a given path
 * Session naming follows tmuxdev convention: {folderName}-{branchName}
 */
export async function getTmuxSessionInfo(
  repoPath: string,
  branch?: string
): Promise<TmuxSessionInfo | null> {
  try {
    // Get folder name
    const folderName = path.basename(repoPath);

    // Create session name using tmuxdev logic
    const sessionName = branch ? `${folderName}-${branch}` : folderName;

    // Check if session exists
    let exists = false;
    try {
      await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
      exists = true;
    } catch {
      exists = false;
    }

    return {
      name: sessionName,
      exists,
    };
  } catch (error) {
    console.error('Error getting tmux session info:', error);
    return null;
  }
}

/**
 * Get the last N lines of output from a tmux session
 */
export async function getTmuxSessionOutput(sessionName: string, lines: number = 25): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t "${sessionName}" -p | tail -n ${lines}`);
    return stdout;
  } catch (error) {
    throw new Error(`Failed to capture tmux output: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Create a new tmux session and start dev server
 */
export async function createTmuxSession(
  sessionName: string,
  workDir: string,
  command: string = 'npm run dev'
): Promise<void> {
  try {
    // Escape single quotes in the command
    const escapedCommand = command.replace(/'/g, "'\"'\"'");
    await execAsync(`tmux new-session -d -s "${sessionName}" -c "${workDir}" sh -c '${escapedCommand}'`);
  } catch (error) {
    throw new Error(`Failed to create tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Attach to an existing tmux session (opens terminal)
 */
export async function attachToTmuxSession(sessionName: string): Promise<void> {
  try {
    // Use osascript to open Terminal and attach to the session
    const script = `
      tell application "Terminal"
        activate
        do script "tmux attach-session -t '${sessionName}'"
      end tell
    `;
    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
  } catch (error) {
    throw new Error(`Failed to attach to tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Kill a tmux session
 */
export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execAsync(`tmux kill-session -t "${sessionName}"`);
  } catch (error) {
    throw new Error(`Failed to kill tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if tmux is installed
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execAsync('which tmux');
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect package manager by checking for lock files
 * Returns 'pnpm', 'yarn', or 'npm' (default)
 */
export function detectPackageManager(repoPath: string): 'pnpm' | 'yarn' | 'npm' {
  // Check for pnpm first (most specific)
  if (existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  // Check for yarn
  if (existsSync(path.join(repoPath, 'yarn.lock'))) {
    return 'yarn';
  }

  // Default to npm (also covers package-lock.json)
  return 'npm';
}
