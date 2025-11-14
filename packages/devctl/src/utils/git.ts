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
