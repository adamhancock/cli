import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';

interface ConnectionStatusProps {
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectAttempt: number;
  error: string | null;
  onRetry?: () => void;
}

export function ConnectionStatus({
  isConnected,
  isReconnecting,
  reconnectAttempt,
  error,
  onRetry,
}: ConnectionStatusProps) {
  // Don't show anything if connected and no error
  if (isConnected && !error) {
    return null;
  }

  const getStatusColor = () => {
    if (isConnected) return '#10b981'; // green
    if (isReconnecting) return '#f59e0b'; // orange
    return '#ef4444'; // red
  };

  const getStatusText = () => {
    if (isConnected) return 'Connected';
    if (isReconnecting) {
      return `Reconnecting... (attempt ${reconnectAttempt})`;
    }
    return 'Disconnected';
  };

  const statusColor = getStatusColor();
  const statusText = getStatusText();

  return (
    <View style={[styles.container, { backgroundColor: `${statusColor}15` }]}>
      <View style={styles.leftContent}>
        <View style={[styles.indicator, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>
          {statusText}
        </Text>
        {isReconnecting && (
          <ActivityIndicator size="small" color={statusColor} style={styles.spinner} />
        )}
      </View>

      {!isConnected && !isReconnecting && onRetry && (
        <TouchableOpacity
          style={[styles.retryButton, { borderColor: statusColor }]}
          onPress={onRetry}
          activeOpacity={0.7}
        >
          <Text style={[styles.retryText, { color: statusColor }]}>Retry</Text>
        </TouchableOpacity>
      )}

      {error && (
        <Text style={styles.errorText} numberOfLines={1}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  leftContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  spinner: {
    marginLeft: 8,
  },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    marginLeft: 8,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
    flex: 1,
  },
});
