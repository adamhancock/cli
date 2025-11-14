import { createWorktree as createWorktreeNative } from './worktree-core';
import type { WorktreeRcConfig } from '../types/worktree-config';

export interface WorktreeConfig {
  repoPath: string;
  config?: WorktreeRcConfig; // Optional configuration override
  baseBranch?: string; // Optional base branch to create from
  force?: boolean; // Force remove existing directory and recreate
}

export interface WorktreeResult {
  success: boolean;
  output: string;
  worktreePath?: string;
  error?: string;
}

export type OutputCallback = (chunk: string) => void;

/**
 * Create a new git worktree using native TypeScript implementation
 */
export async function createWorktree(branchName: string, config: WorktreeConfig): Promise<WorktreeResult> {
  // Replace spaces with dashes
  const sanitizedBranchName = branchName.replace(/\s+/g, '-');

  let fullOutput = '';
  const appendOutput = (message: string) => {
    fullOutput += message + '\n';
  };

  const result = await createWorktreeNative({
    branchName: sanitizedBranchName,
    repoPath: config.repoPath,
    config: config.config,
    baseBranch: config.baseBranch,
    force: config.force,
    onOutput: appendOutput,
    skipVSCode: false,
  });

  return {
    success: result.success,
    output: fullOutput,
    worktreePath: result.worktreePath,
    error: result.error,
  };
}

/**
 * Create a new git worktree with streaming output using native TypeScript implementation
 */
export async function createWorktreeStreaming(
  branchName: string,
  config: WorktreeConfig,
  onOutput: OutputCallback
): Promise<WorktreeResult> {
  // Replace spaces with dashes
  const sanitizedBranchName = branchName.replace(/\s+/g, '-');

  let fullOutput = '';
  const wrappedOutput = (message: string, type?: 'info' | 'success' | 'warning' | 'error') => {
    fullOutput += message + '\n';
    onOutput(message + '\n');
  };

  const result = await createWorktreeNative({
    branchName: sanitizedBranchName,
    repoPath: config.repoPath,
    config: config.config,
    baseBranch: config.baseBranch,
    force: config.force,
    onOutput: wrappedOutput,
    skipVSCode: false,
  });

  return {
    success: result.success,
    output: fullOutput,
    worktreePath: result.worktreePath,
    error: result.error,
  };
}

/**
 * Open a worktree path in VS Code
 * @deprecated This function is now handled by the worktree creation itself
 */
export async function openWorktreeInVSCode(worktreePath: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`open -a "Visual Studio Code" "${worktreePath}"`);
  } catch (error) {
    throw new Error(`Failed to open VS Code: ${error instanceof Error ? error.message : String(error)}`);
  }
}
