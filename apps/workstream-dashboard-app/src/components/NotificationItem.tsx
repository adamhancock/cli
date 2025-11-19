import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { Notification, NotificationType } from '../context/NotificationContext';

interface NotificationItemProps {
  notification: Notification;
  onPress?: () => void;
}

/**
 * Individual notification item for the notification list
 */
export function NotificationItem({ notification, onPress }: NotificationItemProps) {
  const icon = getIcon(notification.type);
  const iconColor = getIconColor(notification.type);

  return (
    <TouchableOpacity
      style={[styles.container, !notification.read && styles.unread]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.iconContainer, { backgroundColor: iconColor }]}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>
          {notification.title}
        </Text>
        <Text style={styles.message} numberOfLines={2}>
          {notification.message}
        </Text>
        <Text style={styles.timestamp}>
          {formatTimestamp(notification.timestamp)}
        </Text>
      </View>
      {!notification.read && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );
}

function getIcon(type: NotificationType): string {
  switch (type) {
    case 'claude':
      return '🤖';
    case 'pr_check_failed':
      return '❌';
    case 'pr_check_success':
      return '✅';
    case 'pr_merge_blocked':
      return '⚠️';
    default:
      return 'ℹ️';
  }
}

function getIconColor(type: NotificationType): string {
  switch (type) {
    case 'claude':
      return '#1e3a8a'; // Dark blue
    case 'pr_check_failed':
      return '#7f1d1d'; // Dark red
    case 'pr_check_success':
      return '#14532d'; // Dark green
    case 'pr_merge_blocked':
      return '#7c2d12'; // Dark orange
    default:
      return '#374151'; // Dark gray
  }
}

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return 'Just now';
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else if (days < 7) {
    return `${days}d ago`;
  } else {
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  }
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    backgroundColor: '#1e293b',
  },
  unread: {
    backgroundColor: '#334155',
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  icon: {
    fontSize: 18,
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f1f5f9',
    marginBottom: 2,
  },
  message: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 4,
  },
  timestamp: {
    fontSize: 11,
    color: '#64748b',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3b82f6',
    marginLeft: 8,
    alignSelf: 'center',
  },
});
