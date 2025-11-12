import { exec } from 'child_process';
import { promisify } from 'util';
import type { PRStatus, PRCheck } from '../types';

const execAsync = promisify(exec);

/**
 * Get PR status for a given repository path and branch
 */
export async function getPRStatus(repoPath: string, branch?: string): Promise<PRStatus | null> {
  try {
    // Check if this is a GitHub repository
    const { stdout: remoteUrl } = await execAsync(
      `/usr/bin/git -C "${repoPath}" remote get-url origin 2>/dev/null || true`
    );

    if (!remoteUrl || !remoteUrl.includes('github.com')) {
      return null;
    }

    // Get current branch if not provided
    if (!branch) {
      const { stdout: currentBranch } = await execAsync(
        `/usr/bin/git -C "${repoPath}" rev-parse --abbrev-ref HEAD`
      );
      branch = currentBranch.trim();
    }

    // Get basic PR information using branch name and repo URL
    const { stdout: prInfo } = await execAsync(
      `/opt/homebrew/bin/gh pr view "${branch}" --repo="$(/usr/bin/git -C "${repoPath}" remote get-url origin)" --json number,title,url,state,author,mergeable,labels 2>/dev/null`
    );

    if (!prInfo.trim()) {
      return null;
    }

    const pr = JSON.parse(prInfo);

    // Get PR check status for open PRs
    let checks: PRStatus['checks'] | undefined;
    if (pr.state === 'OPEN') {
      try {
        const { stdout: checksInfo } = await execAsync(
          `/opt/homebrew/bin/gh pr checks "${branch}" --repo="$(/usr/bin/git -C "${repoPath}" remote get-url origin)" --json bucket,name,state 2>/dev/null`
        );

        if (checksInfo.trim()) {
          const checkResults: PRCheck[] = JSON.parse(checksInfo);

          const passing = checkResults.filter((c) => c.bucket === 'pass').length;
          const failing = checkResults.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').length;
          const actuallyPending = checkResults.filter((c) => c.bucket === 'pending').length;
          const skipping = checkResults.filter((c) => c.bucket === 'skipping').length;

          // Total pending includes both pending and skipping for display
          const pending = actuallyPending + skipping;

          let conclusion: 'success' | 'failure' | 'pending';
          // Only consider 'pending' bucket as actually running, not 'skipping'
          if (actuallyPending > 0) {
            conclusion = 'pending';
          } else if (failing > 0) {
            conclusion = 'failure';
          } else {
            conclusion = 'success';
          }

          checks = {
            total: checkResults.length,
            passing,
            failing,
            pending,
            conclusion,
            runs: checkResults,
          };
        }
      } catch {
        // No checks available or gh pr checks failed
      }
    }

    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: pr.author?.login || pr.author?.name || 'Unknown',
      mergeable: pr.mergeable,
      labels: pr.labels?.map((label: { name: string }) => label.name) || [],
      checks,
    };
  } catch (error) {
    // No PR for this branch or gh command failed
    return null;
  }
}

/**
 * Check if gh CLI is installed and authenticated
 */
export async function isGitHubCLIAvailable(): Promise<boolean> {
  try {
    await execAsync('/opt/homebrew/bin/gh auth status 2>/dev/null');
    return true;
  } catch {
    return false;
  }
}
