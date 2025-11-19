import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Dimensions } from 'react-native';
import type { Notification, NotificationType } from '../context/NotificationContext';

interface ToastProps {
  notification: Notification;
  onDismiss: () => void;
  autoDismiss?: boolean;
  duration?: number;
}

/**
 * Toast notification component with slide-in animation
 * Auto-dismisses after specified duration
 */
export function Toast({ notification, onDismiss, autoDismiss = true, duration = 5000 }: ToastProps) {
  const slideAnim = useRef(new Animated.Value(-100)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Slide in
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-dismiss
    if (autoDismiss) {
      const timer = setTimeout(() => {
        dismiss();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [autoDismiss, duration]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: -100,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss();
    });
  };

  const backgroundColor = getBackgroundColor(notification.type);
  const icon = getIcon(notification.type);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor,
          transform: [{ translateY: slideAnim }],
          opacity: opacityAnim,
        },
      ]}
    >
      <TouchableOpacity
        style={styles.content}
        onPress={dismiss}
        activeOpacity={0.9}
      >
        <Text style={styles.icon}>{icon}</Text>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{notification.title}</Text>
          <Text style={styles.message}>{notification.message}</Text>
        </View>
        <TouchableOpacity onPress={dismiss} style={styles.closeButton}>
          <Text style={styles.closeIcon}>✕</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

/**
 * Container for managing multiple toasts
 * Shows one toast at a time
 */
export function ToastContainer({ notifications, onDismiss }: {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}) {
  // Show only the most recent notification
  const currentNotification = notifications[0];

  if (!currentNotification) {
    return null;
  }

  return (
    <View style={styles.toastContainer}>
      <Toast
        notification={currentNotification}
        onDismiss={() => onDismiss(currentNotification.id)}
      />
    </View>
  );
}

function getBackgroundColor(type: NotificationType): string {
  switch (type) {
    case 'claude':
      return '#3b82f6'; // Blue
    case 'pr_check_failed':
      return '#ef4444'; // Red
    case 'pr_check_success':
      return '#22c55e'; // Green
    case 'pr_merge_blocked':
      return '#f59e0b'; // Orange
    default:
      return '#6b7280'; // Gray
  }
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

const styles = StyleSheet.create({
  toastContainer: {
    position: 'absolute',
    top: 80,
    left: 16,
    right: 16,
    zIndex: 9999,
    alignItems: 'center',
  },
  container: {
    borderRadius: 12,
    padding: 16,
    maxWidth: 600,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 24,
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 4,
  },
  message: {
    fontSize: 13,
    color: '#ffffff',
    opacity: 0.9,
  },
  closeButton: {
    padding: 4,
    marginLeft: 8,
  },
  closeIcon: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: 'bold',
  },
});
