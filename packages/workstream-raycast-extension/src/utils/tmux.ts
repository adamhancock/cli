import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// Cache tmux path after first lookup
let cachedTmuxPath: string | null = null;

/**
 * Get the full path to tmux binary
 */
async function getTmuxPath(): Promise<string> {
  if (cachedTmuxPath) {
    return cachedTmuxPath;
  }

  // Try common paths first (faster than which command)
  const commonPaths = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const tmuxPath of commonPaths) {
    if (existsSync(tmuxPath)) {
      cachedTmuxPath = tmuxPath;
      return tmuxPath;
    }
  }

  // Fallback to which command
  try {
    const { stdout } = await execAsync('which tmux', { shell: '/bin/bash' });
    cachedTmuxPath = stdout.trim();
    return cachedTmuxPath;
  } catch {
    // If all else fails, hope it's in PATH
    return 'tmux';
  }
}

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
 * Pass -1 for lines to get all available lines
 */
export async function getTmuxSessionOutput(sessionName: string, lines: number = 25): Promise<string> {
  try {
    const tmuxPath = await getTmuxPath();

    // If lines is -1, get all lines (don't use tail)
    const command = lines === -1
      ? `"${tmuxPath}" capture-pane -t "${sessionName}" -p`
      : `"${tmuxPath}" capture-pane -t "${sessionName}" -p | /usr/bin/tail -n ${lines}`;

    console.log('Executing command:', command);

    // Increase maxBuffer to handle large log outputs (10MB)
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/bash',
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
    });

    if (stderr) {
      console.error('stderr from tmux command:', stderr);
    }

    console.log('stdout length:', stdout.length);
    return stdout;
  } catch (error) {
    console.error('Failed to capture tmux output:', error);
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
