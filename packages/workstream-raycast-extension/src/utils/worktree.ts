import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export interface WorktreeConfig {
  repoPath: string;
  worktreeCommand?: string; // Path to worktree binary, defaults to ~/Library/pnpm/worktree
}

export interface WorktreeResult {
  success: boolean;
  output: string;
  worktreePath?: string;
  error?: string;
}

export type OutputCallback = (chunk: string) => void;

/**
 * Create a new git worktree using the worktree CLI tool
 */
export async function createWorktree(
  branchName: string,
  config: WorktreeConfig
): Promise<WorktreeResult> {
  try {
    // Replace spaces with dashes
    const sanitizedBranchName = branchName.replace(/\s+/g, '-');

    // Default to ~/Library/pnpm/worktree if not specified
    const worktreeCommand = config.worktreeCommand || join(homedir(), 'Library', 'pnpm', 'worktree');

    // Source NVM and execute the worktree command
    const nvmDir = join(homedir(), '.nvm');
    const command = `
      export NVM_DIR="${nvmDir}"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      cd "${config.repoPath}" && "${worktreeCommand}" "${sanitizedBranchName}"
    `;

    // Set up a proper PATH with standard Unix tool locations
    const properPath = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      join(homedir(), '.nvm/versions/node'),
      process.env.PATH || '',
    ].filter(Boolean).join(':');

    // Execute the worktree command in the repo directory
    const { stdout, stderr } = await execAsync(command, {
      env: {
        ...process.env,
        NVM_DIR: nvmDir,
        PATH: properPath,
        HOME: homedir(),
      },
      shell: '/bin/zsh',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    });

    const output = stdout + stderr;

    // Extract the worktree path from output
    // Look for "Opening VS Code at: /path/to/worktree"
    const pathMatch = output.match(/Opening VS Code at:\s*(.+)/);
    const worktreePath = pathMatch ? pathMatch[1].trim() : undefined;

    return {
      success: true,
      output,
      worktreePath,
    };
  } catch (error: any) {
    // Get detailed error information
    const stdout = error.stdout || '';
    const stderr = error.stderr || '';
    const errorMessage = error.message || String(error);
    const fullOutput = `${stdout}\n${stderr}\n${errorMessage}`.trim();

    return {
      success: false,
      output: fullOutput,
      error: fullOutput || 'Unknown error occurred',
    };
  }
}

/**
 * Create a new git worktree with streaming output
 */
export async function createWorktreeStreaming(
  branchName: string,
  config: WorktreeConfig,
  onOutput: OutputCallback
): Promise<WorktreeResult> {
  return new Promise((resolve) => {
    // Replace spaces with dashes
    const sanitizedBranchName = branchName.replace(/\s+/g, '-');

    // Default to ~/Library/pnpm/worktree if not specified
    const worktreeCommand = config.worktreeCommand || join(homedir(), 'Library', 'pnpm', 'worktree');

    // Source NVM and execute the worktree command
    const nvmDir = join(homedir(), '.nvm');
    const command = `
      export NVM_DIR="${nvmDir}"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      cd "${config.repoPath}" && "${worktreeCommand}" "${sanitizedBranchName}"
    `;

    // Set up a proper PATH with standard Unix tool locations
    const properPath = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      join(homedir(), '.nvm/versions/node'),
      process.env.PATH || '',
    ].filter(Boolean).join(':');

    let fullOutput = '';

    const child = spawn('/bin/zsh', ['-c', command], {
      env: {
        ...process.env,
        NVM_DIR: nvmDir,
        PATH: properPath,
        HOME: homedir(),
      },
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;
      onOutput(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;
      onOutput(chunk);
    });

    child.on('close', (code) => {
      // Extract the worktree path from output
      const pathMatch = fullOutput.match(/Opening VS Code at:\s*(.+)/);
      const worktreePath = pathMatch ? pathMatch[1].trim() : undefined;

      if (code === 0) {
        resolve({
          success: true,
          output: fullOutput,
          worktreePath,
        });
      } else {
        resolve({
          success: false,
          output: fullOutput,
          error: fullOutput || 'Command failed',
        });
      }
    });

    child.on('error', (error) => {
      const errorMessage = error.message || String(error);
      fullOutput += `\nError: ${errorMessage}`;
      onOutput(`\nError: ${errorMessage}`);

      resolve({
        success: false,
        output: fullOutput,
        error: errorMessage,
      });
    });
  });
}

/**
 * Open a worktree path in VS Code
 */
export async function openWorktreeInVSCode(worktreePath: string): Promise<void> {
  try {
    await execAsync(`open -a "Visual Studio Code" "${worktreePath}"`);
  } catch (error) {
    throw new Error(`Failed to open VS Code: ${error instanceof Error ? error.message : String(error)}`);
  }
}
