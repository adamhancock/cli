import React from 'react';
import { ScrollView, View, Text, StyleSheet, RefreshControl } from 'react-native';
import type { Instance } from '../types';
import { InstanceCard } from './InstanceCard';

interface InstanceGridProps {
  instances: Instance[];
  isLoading?: boolean;
  onRefresh?: () => void;
}

/**
 * Grid layout component for displaying instance cards
 * Optimized for iPad landscape orientation
 */
export function InstanceGrid({ instances, isLoading = false, onRefresh }: InstanceGridProps) {
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
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={isLoading} onRefresh={onRefresh} />
        ) : undefined
      }
    >
      <View style={styles.grid}>
        {instances.map((instance) => (
          <InstanceCard key={instance.path} instance={instance} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },
  scrollContent: {
    padding: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  emptyText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#9ca3af',
  },
});
