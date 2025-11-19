import React from 'react';
import { ScrollView, View, Text, StyleSheet, RefreshControl } from 'react-native';
import type { Instance } from '../types';
import { StatusBadge, BadgeStatus } from './StatusBadge';

interface InstanceTableProps {
  instances: Instance[];
  isLoading?: boolean;
  onRefresh?: () => void;
}

/**
 * Table layout component for displaying instances
 * Optimized for iPad landscape orientation
 */
export function InstanceTable({ instances, isLoading = false, onRefresh }: InstanceTableProps) {
  if (instances.length === 0 && !isLoading) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No workspaces found</Text>
        <Text style={styles.emptySubtext}>
          Open VS Code workspaces to see them here
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} />
        ) : undefined
      }
    >
      <View style={styles.table}>
        {/* Table Header */}
        <View style={styles.headerRow}>
          <Text style={[styles.headerCell, styles.nameColumn]}>Workspace</Text>
          <Text style={[styles.headerCell, styles.prColumn]}>Pull Request</Text>
          <Text style={[styles.headerCell, styles.claudeColumn]}>Claude</Text>
        </View>

        {/* Table Rows */}
        {instances.map((instance, index) => (
          <InstanceRow key={instance.path} instance={instance} index={index} />
        ))}
      </View>
    </ScrollView>
  );
}

function InstanceRow({ instance, index }: { instance: Instance; index: number }) {
  const prStatus = getPRStatus(instance);
  const claudeStatus = getClaudeStatus(instance);

  return (
    <View style={[styles.row, index % 2 === 0 ? styles.evenRow : styles.oddRow]}>
      {/* Name */}
      <View style={styles.nameColumn}>
        <Text style={styles.nameText} numberOfLines={1}>
          {instance.name}
        </Text>
      </View>

      {/* PR Status */}
      <View style={styles.prColumn}>
        {instance.prStatus ? (
          <View>
            <View style={styles.statusBadgeContainer}>
              {prStatus && <StatusBadge {...prStatus} />}
            </View>
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
        ) : (
          <Text style={styles.noPrText}>—</Text>
        )}
      </View>

      {/* Claude Status */}
      <View style={styles.claudeColumn}>
        {claudeStatus ? (
          <View style={styles.statusBadgeContainer}>
            <StatusBadge {...claudeStatus} />
          </View>
        ) : (
          <Text style={styles.noClaudeText}>—</Text>
        )}
      </View>
    </View>
  );
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

  if (mergeable === 'CONFLICTING') {
    return {
      type: 'pr' as const,
      status: 'error' as BadgeStatus,
      label: 'Conflicts',
    };
  }

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

  const { isWorking, isWaiting, claudeFinished } = instance.claudeStatus;

  if (claudeFinished) {
    return {
      type: 'claude' as const,
      status: 'success' as BadgeStatus,
      label: 'Finished',
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

  return {
    type: 'claude' as const,
    status: 'neutral' as BadgeStatus,
    label: 'Idle',
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  table: {
    margin: 16,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: '#334155',
    borderBottomWidth: 2,
    borderBottomColor: '#475569',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headerCell: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 60,
  },
  evenRow: {
    backgroundColor: '#1e293b',
  },
  oddRow: {
    backgroundColor: '#334155',
  },
  nameColumn: {
    flex: 2,
    justifyContent: 'center',
  },
  prColumn: {
    flex: 3,
    justifyContent: 'center',
  },
  claudeColumn: {
    flex: 1,
    justifyContent: 'center',
  },
  nameText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f1f5f9',
  },
  statusBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  prTitle: {
    fontSize: 12,
    color: '#cbd5e1',
    marginTop: 4,
  },
  checksText: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  noPrText: {
    fontSize: 14,
    color: '#475569',
  },
  noClaudeText: {
    fontSize: 14,
    color: '#475569',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  emptyText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#64748b',
  },
});
