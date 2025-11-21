import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Instance } from '../types';
import { StatusBadge, BadgeStatus } from './StatusBadge';

interface InstanceCardProps {
  instance: Instance;
}

/**
 * Card component displaying a workspace instance with all its status information
 */
export function InstanceCard({ instance }: InstanceCardProps) {
  const gitStatus = getGitStatus(instance);
  const prStatus = getPRStatus(instance);
  const claudeStatus = getClaudeStatus(instance);

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {instance.name}
        </Text>
      </View>

      {/* Branch info */}
      {instance.gitInfo && (
        <View style={styles.branchRow}>
          <Text style={styles.branchText} numberOfLines={1}>
            {instance.gitInfo.branch}
          </Text>
          {(instance.gitInfo.ahead || instance.gitInfo.behind) && (
            <Text style={styles.syncText}>
              {instance.gitInfo.ahead ? `↑${instance.gitInfo.ahead}` : ''}
              {instance.gitInfo.ahead && instance.gitInfo.behind ? ' ' : ''}
              {instance.gitInfo.behind ? `↓${instance.gitInfo.behind}` : ''}
            </Text>
          )}
        </View>
      )}

      {/* Status badges */}
      <View style={styles.badges}>
        {gitStatus && <StatusBadge {...gitStatus} />}
        {prStatus && <StatusBadge {...prStatus} />}
        {claudeStatus && <StatusBadge {...claudeStatus} />}
      </View>

      {/* PR info */}
      {instance.prStatus && (
        <View style={styles.prInfo}>
          <Text style={styles.prTitle} numberOfLines={1}>
            #{String(instance.prStatus.number)}: {instance.prStatus.title}
          </Text>
          {instance.prStatus.checks && (
            <Text style={styles.checksText}>
              ✓ {String(instance.prStatus.checks.passing)} ✗ {String(instance.prStatus.checks.failing)}
              {instance.prStatus.checks.pending > 0 ? ` ⊚ ${instance.prStatus.checks.pending}` : null}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function getGitStatus(instance: Instance) {
  if (!instance.gitInfo) return null;

  const { isDirty, modified, staged, untracked } = instance.gitInfo;

  if (!isDirty) {
    return {
      type: 'git' as const,
      status: 'success' as BadgeStatus,
      label: 'Clean',
    };
  }

  const changes = modified + staged + untracked;
  return {
    type: 'git' as const,
    status: 'warning' as BadgeStatus,
    label: 'Dirty',
    count: changes,
  };
}

function getPRStatus(instance: Instance) {
  if (!instance.prStatus) return null;

  const { state, checks, mergeable } = instance.prStatus;

  if (state === 'MERGED') {
    return {
      type: 'pr' as const,
      status: 'neutral' as BadgeStatus,
      label: 'Merged',
    };
  }

  if (state === 'CLOSED') {
    return {
      type: 'pr' as const,
      status: 'neutral' as BadgeStatus,
      label: 'Closed',
    };
  }

  // Check if there are conflicts
  if (mergeable === 'CONFLICTING') {
    return {
      type: 'pr' as const,
      status: 'error' as BadgeStatus,
      label: 'Conflicts',
    };
  }

  // Check CI status
  if (checks) {
    if (checks.conclusion === 'failure') {
      return {
        type: 'pr' as const,
        status: 'error' as BadgeStatus,
        label: 'Checks Failed',
        count: checks.failing,
      };
    }

    if (checks.conclusion === 'pending') {
      return {
        type: 'pr' as const,
        status: 'warning' as BadgeStatus,
        label: 'Checks Pending',
        count: checks.pending,
      };
    }

    if (checks.conclusion === 'success') {
      return {
        type: 'pr' as const,
        status: 'success' as BadgeStatus,
        label: 'Checks Passed',
      };
    }
  }

  return {
    type: 'pr' as const,
    status: 'info' as BadgeStatus,
    label: 'Open',
  };
}

function getClaudeStatus(instance: Instance) {
  if (!instance.claudeStatus?.active) return null;

  const { isWorking, isWaiting, isChecking, isCompacting, claudeFinished } = instance.claudeStatus;

  if (claudeFinished) {
    return {
      type: 'claude' as const,
      status: 'success' as BadgeStatus,
      label: 'Finished',
    };
  }

  if (isCompacting) {
    return {
      type: 'claude' as const,
      status: 'info' as BadgeStatus,
      label: 'Compacting',
    };
  }

  if (isWorking) {
    return {
      type: 'claude' as const,
      status: 'info' as BadgeStatus,
      label: 'Working',
    };
  }

  if (isWaiting) {
    return {
      type: 'claude' as const,
      status: 'warning' as BadgeStatus,
      label: 'Waiting',
    };
  }

  if (isChecking) {
    return {
      type: 'claude' as const,
      status: 'warning' as BadgeStatus,
      label: 'Checking',
    };
  }

  return {
    type: 'claude' as const,
    status: 'neutral' as BadgeStatus,
    label: 'Idle',
  };
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    margin: 8,
    minWidth: 280,
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  header: {
    marginBottom: 8,
  },
  name: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111827',
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  branchText: {
    fontSize: 14,
    color: '#6b7280',
    fontFamily: 'monospace',
    flex: 1,
  },
  syncText: {
    fontSize: 12,
    color: '#9ca3af',
    marginLeft: 8,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  prInfo: {
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  prTitle: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 4,
  },
  checksText: {
    fontSize: 12,
    color: '#6b7280',
  },
});
