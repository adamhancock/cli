import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type BadgeType = 'git' | 'pr' | 'claude' | 'error' | 'info';
export type BadgeStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';

interface StatusBadgeProps {
  type: BadgeType;
  status: BadgeStatus;
  label: string;
  count?: number;
}

/**
 * Status badge component for showing git, PR, and Claude status
 */
export function StatusBadge({ type, status, label, count }: StatusBadgeProps) {
  const backgroundColor = getBackgroundColor(status);
  const textColor = getTextColor(status);

  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <Text style={[styles.label, { color: textColor }]}>
        {label}
        {count !== undefined && count > 0 && ` (${count})`}
      </Text>
    </View>
  );
}

function getBackgroundColor(status: BadgeStatus): string {
  switch (status) {
    case 'success':
      return '#22c55e'; // green
    case 'warning':
      return '#f59e0b'; // orange
    case 'error':
      return '#ef4444'; // red
    case 'info':
      return '#3b82f6'; // blue
    case 'neutral':
      return '#6b7280'; // gray
    default:
      return '#6b7280';
  }
}

function getTextColor(status: BadgeStatus): string {
  return '#ffffff'; // white text for all badges
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginRight: 6,
    marginBottom: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
});
