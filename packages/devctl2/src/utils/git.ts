import { $ } from 'zx';

$.verbose = false;

/**
 * Get the current branch name
 */
export async function getBranch(): Promise<string> {
  try {
    const branch = await $`git rev-parse --abbrev-ref HEAD`;
    return branch.stdout.trim();
  } catch {
    return 'main';
  }
}

/**
 * Sanitize branch name for use in subdomains and database names
 */
export function sanitizeBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if the current directory is a git repository
 */
export async function isGitRepo(): Promise<boolean> {
  try {
    await $`git rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the worktree root directory
 */
export async function getWorktreeRoot(): Promise<string> {
  try {
    const result = await $`git rev-parse --show-toplevel`;
    return result.stdout.trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Get the main worktree path (the original repo, not a linked worktree)
 * Returns null if we're already in the main worktree or can't determine it
 */
export async function getMainWorktreePath(): Promise<string | null> {
  try {
    // Get the list of all worktrees
    const result = await $`git worktree list --porcelain`;
    const lines = result.stdout.trim().split('\n');
    
    // Parse worktree entries - the first one is always the main worktree
    let mainWorktreePath: string | null = null;
    let currentWorktreePath: string | null = null;
    
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const path = line.substring('worktree '.length);
        if (mainWorktreePath === null) {
          mainWorktreePath = path;
        }
      }
    }
    
    // Get current worktree path
    currentWorktreePath = await getWorktreeRoot();
    
    // If we're in the main worktree, return null
    if (mainWorktreePath === currentWorktreePath) {
      return null;
    }
    
    return mainWorktreePath;
  } catch {
    return null;
  }
}
