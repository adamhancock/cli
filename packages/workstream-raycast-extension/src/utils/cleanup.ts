import { InstanceWithStatus, CleanupCriteria, CleanupResult } from '../types';
import { closeVSCodeInstance } from './vscode';
import { killTmuxSession } from './tmux';
import { deleteRouteByWorktreePath } from './caddy';

const OLD_WORKTREE_THRESHOLD_DAYS = 7;

/**
 * Find instances that match cleanup criteria
 */
export function findEnvironmentsForCleanup(
  instances: InstanceWithStatus[],
  criteria: CleanupCriteria[]
): InstanceWithStatus[] {
  return instances.filter((instance) => {
    for (const criterion of criteria) {
      switch (criterion) {
        case CleanupCriteria.MergedPRs:
          if (instance.prStatus?.state === 'MERGED') {
            return true;
          }
          break;

        case CleanupCriteria.ClosedPRs:
          if (instance.prStatus?.state === 'CLOSED') {
            return true;
          }
          break;

        case CleanupCriteria.OldWorktrees:
          if (isOldWorktree(instance)) {
            return true;
          }
          break;
      }
    }
    return false;
  });
}

/**
 * Check if a worktree is old (hasn't been used recently)
 */
function isOldWorktree(instance: InstanceWithStatus): boolean {
  // Check if there's a Claude session with recent activity
  if (instance.claudeStatus?.active && instance.claudeStatus.lastActivityTime) {
    const daysSinceActivity = (Date.now() - instance.claudeStatus.lastActivityTime.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceActivity < OLD_WORKTREE_THRESHOLD_DAYS) {
      return false; // Recent activity, not old
    }
  }

  // Check if tmux session is running (indicates active use)
  if (instance.tmuxStatus?.exists) {
    return false; // Active tmux session, not old
  }

  // Check git last commit date
  if (instance.gitInfo?.lastCommit?.date) {
    const commitDate = parseLegacyDate(instance.gitInfo.lastCommit.date);
    if (commitDate) {
      const daysSinceCommit = (Date.now() - commitDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysSinceCommit > OLD_WORKTREE_THRESHOLD_DAYS;
    }
  }

  // If we can't determine age, consider it not old (safe default)
  return false;
}

/**
 * Parse legacy git date formats (e.g., "2 days ago", "3 weeks ago")
 */
function parseLegacyDate(dateStr: string): Date | null {
  const now = new Date();

  // Match patterns like "2 days ago", "3 weeks ago", "1 month ago"
  const match = dateStr.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);

  if (match) {
    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'second':
        return new Date(now.getTime() - amount * 1000);
      case 'minute':
        return new Date(now.getTime() - amount * 60 * 1000);
      case 'hour':
        return new Date(now.getTime() - amount * 60 * 60 * 1000);
      case 'day':
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
      case 'week':
        return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      case 'month':
        return new Date(now.getTime() - amount * 30 * 24 * 60 * 60 * 1000);
      case 'year':
        return new Date(now.getTime() - amount * 365 * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

/**
 * Close a development environment completely (VS Code + tmux + Caddy)
 */
export async function closeEnvironmentCompletely(
  instance: InstanceWithStatus,
  onProgress?: (step: string) => void
): Promise<CleanupResult> {
  const result: CleanupResult = {
    success: false,
    instancePath: instance.path,
    instanceName: instance.name,
    vscodeClosed: false,
    tmuxClosed: false,
    caddyRouteClosed: false,
  };

  try {
    // Step 1: Close tmux session if it exists
    if (instance.tmuxStatus?.exists) {
      onProgress?.('Killing tmux session...');
      try {
        await killTmuxSession(instance.tmuxStatus.name);
        result.tmuxClosed = true;
      } catch (error) {
        console.error('Failed to kill tmux session:', error);
        result.error = `Failed to kill tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`;
        // Continue even if tmux fails
      }
    } else {
      result.tmuxClosed = true; // No tmux to close
    }

    // Step 2: Close VS Code window
    onProgress?.('Closing VS Code window...');
    try {
      await closeVSCodeInstance(instance.path);
      result.vscodeClosed = true;
    } catch (error) {
      console.error('Failed to close VS Code:', error);
      result.error = `Failed to close VS Code: ${error instanceof Error ? error.message : 'Unknown error'}`;
      return result; // Don't continue if VS Code close fails
    }

    // Step 3: Remove Caddy route if it exists
    onProgress?.('Removing Caddy route...');
    try {
      const deleted = await deleteRouteByWorktreePath(instance.path);
      result.caddyRouteClosed = deleted;

      if (!deleted) {
        // Not necessarily an error - the route might not exist
        console.log('No Caddy route found for this worktree');
        result.caddyRouteClosed = true; // Consider it "closed" if there was nothing to close
      }
    } catch (error) {
      console.error('Failed to delete Caddy route:', error);
      // Don't fail the entire operation if Caddy cleanup fails
      result.caddyRouteClosed = false;
    }

    result.success = result.vscodeClosed; // Success if at least VS Code was closed

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Close multiple environments in sequence
 */
export async function closeEnvironments(
  instances: InstanceWithStatus[],
  onProgress?: (instanceName: string, step: string) => void
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];

  for (const instance of instances) {
    const result = await closeEnvironmentCompletely(instance, (step) => {
      onProgress?.(instance.name, step);
    });
    results.push(result);
  }

  return results;
}

/**
 * Get a summary of what will be cleaned up
 */
export function getCleanupSummary(instances: InstanceWithStatus[]): {
  totalCount: number;
  mergedPRCount: number;
  closedPRCount: number;
  oldWorktreeCount: number;
  withTmux: number;
  withCaddy: number;
} {
  return {
    totalCount: instances.length,
    mergedPRCount: instances.filter((i) => i.prStatus?.state === 'MERGED').length,
    closedPRCount: instances.filter((i) => i.prStatus?.state === 'CLOSED').length,
    oldWorktreeCount: instances.filter(isOldWorktree).length,
    withTmux: instances.filter((i) => i.tmuxStatus?.exists).length,
    withCaddy: instances.filter((i) => i.caddyHost).length,
  };
}
