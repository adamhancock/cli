import { exec } from 'child_process';
import { promisify } from 'util';
import type { GitInfo } from '../types';

const execAsync = promisify(exec);

/**
 * Get git information for a repository
 */
export async function getGitInfo(repoPath: string): Promise<GitInfo | null> {
  try {
    // Run multiple git commands in parallel for speed
    const [branchResult, statusResult, remoteResult] = await Promise.allSettled([
      // Get current branch
      execAsync(`/usr/bin/git -C "${repoPath}" rev-parse --abbrev-ref HEAD`),
      // Get repository status
      execAsync(`/usr/bin/git -C "${repoPath}" status --porcelain`),
      // Get remote tracking branch
      execAsync(`/usr/bin/git -C "${repoPath}" rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null`),
    ]);

    if (branchResult.status === 'rejected' || statusResult.status === 'rejected') {
      return null;
    }

    const branch = branchResult.value.stdout.trim();
    const statusOutput = statusResult.value.stdout;

    // Get remote tracking branch and ahead/behind counts
    let remoteBranch: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;

    if (remoteResult.status === 'fulfilled' && remoteResult.value.stdout.trim()) {
      remoteBranch = remoteResult.value.stdout.trim();

      try {
        // Get ahead/behind counts
        const { stdout: counts } = await execAsync(
          `/usr/bin/git -C "${repoPath}" rev-list --left-right --count ${remoteBranch}...HEAD`
        );
        const [behindCount, aheadCount] = counts.trim().split('\t').map(Number);
        ahead = aheadCount;
        behind = behindCount;
      } catch {
        // Ignore errors getting counts
      }
    }

    const statusLines = statusOutput.trim().split('\n').filter(Boolean);
    const modified = statusLines.filter((line) => line.startsWith(' M')).length;
    const staged = statusLines.filter((line) => line.match(/^[MARC]/)).length;
    const untracked = statusLines.filter((line) => line.startsWith('??')).length;
    const isDirty = statusLines.length > 0;

    // Get last commit info
    let lastCommit: GitInfo['lastCommit'] | undefined;
    try {
      const { stdout: commitInfo } = await execAsync(
        `/usr/bin/git -C "${repoPath}" log -1 --pretty=format:%s|%an|%ar`
      );

      const [message, author, date] = commitInfo.split('|');
      lastCommit = { message, author, date };
    } catch {
      // No commits yet
    }

    return {
      branch: branch.trim(),
      isGitRepo: true,
      remoteBranch,
      ahead,
      behind,
      isDirty,
      modified,
      staged,
      untracked,
      lastCommit,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execAsync(`/usr/bin/git -C "${repoPath}" rev-parse --git-dir`);
    return true;
  } catch {
    return false;
  }
}
