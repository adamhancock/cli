import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { Instance, ClaudeEventData, NotificationData } from '../types';

interface UseWorkstreamOptions {
  serverUrl?: string;
  token?: string;
  autoConnect?: boolean;
  onNotification?: (notification: {
    type: string;
    title: string;
    message: string;
    path?: string;
  }) => void;
}

interface UseWorkstreamReturn {
  instances: Instance[];
  isConnected: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook to manage WebSocket connection to workstream daemon
 * Provides real-time instance updates
 */
export function useWorkstream(options: UseWorkstreamOptions = {}): UseWorkstreamReturn {
  const { serverUrl = 'http://localhost:9995', token, autoConnect = true, onNotification } = options;

  const [instances, setInstances] = useState<Instance[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Initialize socket connection
  useEffect(() => {
    if (!autoConnect) return;

    // If token is required but not provided, don't connect yet
    // But we don't strictly know if it's required yet, so we'll try
    // Note: If we have a token, we should send it.

    console.log('[Workstream] Connecting to', serverUrl);

    const newSocket = io(serverUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      auth: {
        token,
      },
    });

    // Connection handlers
    newSocket.on('connect', () => {
      console.log('[Workstream] Connected');
      setIsConnected(true);
      setError(null);
      // Subscribe to updates
      newSocket.emit('subscribe');
    });

    newSocket.on('disconnect', () => {
      console.log('[Workstream] Disconnected');
      setIsConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      console.error('[Workstream] Connection error:', err.message);
      setError(`Connection error: ${err.message}`);
      setIsConnected(false);
    });

    // Data handlers
    newSocket.on('instances', (instanceList: Instance[]) => {
      console.log('[Workstream] Received instances:', instanceList.length);
      setInstances(instanceList);
    });

    newSocket.on('instance-updated', (instance: Instance) => {
      console.log('[Workstream] Instance updated:', instance.name);
      setInstances((prev) => {
        const index = prev.findIndex((i) => i.path === instance.path);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = instance;
          return updated;
        } else {
          return [...prev, instance];
        }
      });
    });

    newSocket.on('claude-event', (data: ClaudeEventData) => {
      console.log('[Workstream] Claude event:', data.type, data.path);

      // Create notification for Claude events
      if (onNotification && data.path) {
        const workspaceName = data.path.split('/').pop() || data.path;
        let title = '';
        let message = '';

        if (data.type === 'work_started') {
          title = 'Claude Started';
          message = `Working on ${workspaceName}`;
        } else if (data.type === 'waiting_for_input') {
          title = 'Claude Waiting';
          message = `Needs input on ${workspaceName}`;
        } else if (data.type === 'work_stopped') {
          title = 'Claude Finished';
          message = `Completed work on ${workspaceName}`;
        }

        if (title && message) {
          onNotification({
            type: 'claude',
            title,
            message,
            path: data.path,
          });
        }
      }
    });

    newSocket.on('notification', (data: NotificationData) => {
      console.log('[Workstream] Notification:', data.title, data.message);

      // Forward notification to callback
      if (onNotification) {
        onNotification({
          type: data.type,
          title: data.title,
          message: data.message,
          path: data.path,
        });
      }
    });

    setSocket(newSocket);

    // Cleanup on unmount
    return () => {
      console.log('[Workstream] Disconnecting...');
      newSocket.disconnect();
    };
  }, [serverUrl, token, autoConnect, onNotification]);

  // Refresh instances
  const refresh = useCallback(() => {
    if (socket && isConnected) {
      console.log('[Workstream] Requesting refresh...');
      socket.emit('get-instances');
    }
  }, [socket, isConnected]);

  return {
    instances,
    isConnected,
    error,
    refresh,
  };
}
