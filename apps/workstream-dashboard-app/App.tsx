import React, { useState, useCallback, useEffect } from 'react';
import { StyleSheet, View, Text, StatusBar, TouchableOpacity } from 'react-native';
import { InstanceTable } from './src/components/InstanceTable';
import { NotificationList } from './src/components/NotificationList';
import { ToastContainer } from './src/components/Toast';
import { SettingsModal } from './src/components/SettingsModal';
import { useWorkstream } from './src/hooks/useWorkstream';
import { NotificationProvider, useNotifications } from './src/context/NotificationContext';
import type { NotificationType } from './src/context/NotificationContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'workstream_server_url';
const AUTH_TOKEN_KEY = 'workstream_auth_token';
const DEFAULT_URL = 'http://localhost:9995';

function AppContent() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_URL);
  const [serverToken, setServerToken] = useState('');
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastQueue, setToastQueue] = useState<any[]>([]);
  const { addNotification, unreadCount } = useNotifications();

  // Load persisted URL on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const savedUrl = await AsyncStorage.getItem(SERVER_URL_KEY);
      if (savedUrl) {
        setServerUrl(savedUrl);
      }
      const savedToken = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      if (savedToken) {
        setServerToken(savedToken);
      }
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  };

  const handleSaveSettings = async (url: string, token: string) => {
    try {
      await AsyncStorage.setItem(SERVER_URL_KEY, url);
      await AsyncStorage.setItem(AUTH_TOKEN_KEY, token);
      setServerUrl(url);
      setServerToken(token);
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  };

  // Handle notifications from WebSocket
  const handleNotification = useCallback((notification: {
    type: string;
    title: string;
    message: string;
    path?: string;
  }) => {
    // Map notification types to our NotificationType
    let notificationType: NotificationType;
    if (notification.type === 'claude') {
      notificationType = 'claude';
    } else if (notification.type === 'pr_check_failed' || notification.type === 'claude_waiting') {
      notificationType = 'pr_check_failed';
    } else if (notification.type === 'pr_check_success' || notification.type === 'claude_finished') {
      notificationType = 'pr_check_success';
    } else if (notification.type === 'pr_merge_blocked') {
      notificationType = 'pr_merge_blocked';
    } else {
      // Default to appropriate type based on content
      if (notification.title.toLowerCase().includes('fail')) {
        notificationType = 'pr_check_failed';
      } else if (notification.title.toLowerCase().includes('success') || notification.title.toLowerCase().includes('pass')) {
        notificationType = 'pr_check_success';
      } else if (notification.title.toLowerCase().includes('conflict')) {
        notificationType = 'pr_merge_blocked';
      } else {
        notificationType = 'claude';
      }
    }

    // Add to notification context
    addNotification({
      type: notificationType,
      title: notification.title,
      message: notification.message,
      path: notification.path,
    });

    // Add to toast queue
    setToastQueue((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        type: notificationType,
        title: notification.title,
        message: notification.message,
        timestamp: Date.now(),
        read: false,
      },
    ]);
  }, [addNotification]);

  const { instances, isConnected, error, refresh } = useWorkstream({
    serverUrl,
    token: serverToken,
    onNotification: handleNotification,
  });

  const handleToastDismiss = (id: string) => {
    setToastQueue((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Workstream Dashboard</Text>
        <View style={styles.headerRight}>
          <View style={[styles.statusDot, { backgroundColor: isConnected ? '#22c55e' : '#ef4444' }]} />
          <Text style={styles.statusText}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Text>
          <Text style={styles.instanceCount}>
            {String(instances.length)} {instances.length === 1 ? 'workspace' : 'workspaces'}
          </Text>
          
          <TouchableOpacity
            onPress={() => setSettingsOpen(true)}
            style={styles.settingsButton}
          >
            <Text style={styles.settingsButtonText}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Error message */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorSubtext}>Make sure workstream daemon is running at {serverUrl}</Text>
        </View>
      )}

      {/* Main content area */}
      <View style={styles.contentArea}>
        {/* Instance table */}
        <View style={styles.tableContainer}>
          <InstanceTable
            instances={instances}
            isLoading={!isConnected}
            onRefresh={refresh}
          />
        </View>

        {/* Notification panel */}
        <View style={styles.notificationContainer}>
          <NotificationList />
        </View>
      </View>

      {/* Toast notifications */}
      <ToastContainer
        notifications={toastQueue}
        onDismiss={handleToastDismiss}
      />

      {/* Settings Modal */}
      <SettingsModal
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentUrl={serverUrl}
        currentToken={serverToken}
        onSave={handleSaveSettings}
      />
    </View>
  );
}

export default function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  contentArea: {
    flex: 1,
    flexDirection: 'column',
  },
  tableContainer: {
    flex: 1,
  },
  notificationContainer: {
    height: 300,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f1f5f9',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    color: '#94a3b8',
    marginRight: 16,
  },
  instanceCount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#334155',
    borderRadius: 12,
  },
  errorBanner: {
    backgroundColor: '#7f1d1d',
    borderBottomWidth: 1,
    borderBottomColor: '#991b1b',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  errorText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fecaca',
    marginBottom: 4,
  },
  errorSubtext: {
    fontSize: 12,
    color: '#fca5a5',
  },
  settingsButton: {
    marginLeft: 16,
    padding: 8,
  },
  settingsButtonText: {
    fontSize: 20,
  },
});