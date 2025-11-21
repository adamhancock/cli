import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import type { Instance, ClaudeEventData, NotificationData } from '../types';

interface UseWorkstreamOptions {
  serverUrl?: string;
  token?: string;
  autoConnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectionDelayMax?: number;
  onNotification?: (notification: {
    type: string;
    title: string;
    message: string;
    path?: string;
  }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

interface UseWorkstreamReturn {
  instances: Instance[];
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectAttempt: number;
  error: string | null;
  refresh: () => void;
  manualReconnect: () => void;
}

/**
 * Calculate reconnection delay with exponential backoff and jitter
 */
const getReconnectDelay = (attempt: number, maxDelay: number = 60000): number => {
  const baseDelay = 1000;
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // Add jitter (±25%) to prevent thundering herd
  const jitter = delay * 0.25 * (Math.random() - 0.5);
  return delay + jitter;
};

/**
 * Hook to manage WebSocket connection to workstream daemon
 * Provides real-time instance updates with automatic reconnection
 */
export function useWorkstream(options: UseWorkstreamOptions = {}): UseWorkstreamReturn {
  const {
    serverUrl = 'http://localhost:9995',
    token,
    autoConnect = true,
    maxReconnectAttempts = Infinity,
    reconnectionDelayMax = 60000,
    onNotification,
    onConnectionChange,
  } = options;

  const [instances, setInstances] = useState<Instance[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isManualDisconnect = useRef(false);
  const socketRef = useRef<Socket | null>(null);
  const maxReconnectAttemptsRef = useRef(maxReconnectAttempts);
  const reconnectionDelayMaxRef = useRef(reconnectionDelayMax);
  const onNotificationRef = useRef(onNotification);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const resetReconnectionRef = useRef<(() => void) | undefined>(undefined);
  const attemptReconnectRef = useRef<(() => void) | undefined>(undefined);

  // Update refs when props/callbacks change
  useEffect(() => {
    maxReconnectAttemptsRef.current = maxReconnectAttempts;
    reconnectionDelayMaxRef.current = reconnectionDelayMax;
    onNotificationRef.current = onNotification;
    onConnectionChangeRef.current = onConnectionChange;
  }, [maxReconnectAttempts, reconnectionDelayMax, onNotification, onConnectionChange]);

  // Reset reconnection state on successful connection
  const resetReconnection = useCallback(() => {
    setReconnectAttempt(0);
    setIsReconnecting(false);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Attempt reconnection with exponential backoff
  const attemptReconnect = useCallback(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket || isManualDisconnect.current) return;

    setReconnectAttempt((prev) => {
      const nextAttempt = prev + 1;

      if (nextAttempt > maxReconnectAttemptsRef.current) {
        console.log('[Workstream] Max reconnection attempts reached');
        setIsReconnecting(false);
        setError('Connection failed - max attempts reached');
        return prev;
      }

      const delay = getReconnectDelay(prev, reconnectionDelayMaxRef.current);
      console.log(`[Workstream] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${nextAttempt}/${maxReconnectAttemptsRef.current === Infinity ? '∞' : maxReconnectAttemptsRef.current})`);

      setIsReconnecting(true);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      reconnectTimerRef.current = setTimeout(() => {
        const socket = socketRef.current;
        if (socket && !socket.connected) {
          console.log('[Workstream] Attempting to reconnect...');
          socket.connect();
        }
      }, delay);

      return nextAttempt;
    });
  }, []);

  // Store callbacks in refs for event handlers to access latest version
  resetReconnectionRef.current = resetReconnection;
  attemptReconnectRef.current = attemptReconnect;

  // Manual reconnection (resets attempt counter)
  const manualReconnect = useCallback(() => {
    console.log('[Workstream] Manual reconnect triggered');
    isManualDisconnect.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectAttempt(0);
    setIsReconnecting(true);
    setError(null);

    const currentSocket = socketRef.current;
    if (currentSocket) {
      if (currentSocket.connected) {
        currentSocket.disconnect();
      }
      currentSocket.connect();
    }
  }, []);

  // Initialize socket connection
  useEffect(() => {
    if (!autoConnect) return;

    // If token is required but not provided, don't connect yet
    // But we don't strictly know if it's required yet, so we'll try
    // Note: If we have a token, we should send it.

    console.log('[Workstream] Connecting to', serverUrl);
    isManualDisconnect.current = false;

    const newSocket = io(serverUrl, {
      reconnection: false, // We handle reconnection manually
      transports: ['websocket', 'polling'], // Try websocket first
      timeout: 20000,
      auth: {
        token,
      },
    });

    // Connection handlers
    newSocket.on('connect', () => {
      console.log('[Workstream] Connected');
      setIsConnected(true);
      setError(null);
      resetReconnectionRef.current?.();

      // Notify connection change
      onConnectionChangeRef.current?.(true);

      // Subscribe to updates
      newSocket.emit('subscribe');
    });

    newSocket.on('disconnect', (reason) => {
      console.log('[Workstream] Disconnected:', reason);
      setIsConnected(false);

      // Notify connection change
      onConnectionChangeRef.current?.(false);

      // Attempt reconnection unless it was a manual disconnect
      if (!isManualDisconnect.current && reason !== 'io client disconnect') {
        attemptReconnectRef.current?.();
      }
    });

    newSocket.on('connect_error', (err) => {
      console.error('[Workstream] Connection error:', err.message);
      const errorMsg = err.message.includes('auth')
        ? 'Authentication failed - check token'
        : err.message.includes('timeout')
        ? 'Server not responding'
        : `Connection error: ${err.message}`;

      setError(errorMsg);
      setIsConnected(false);

      // Attempt reconnection on error
      if (!isManualDisconnect.current) {
        attemptReconnectRef.current?.();
      }
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
      if (onNotificationRef.current && data.path) {
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
          onNotificationRef.current({
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
      if (onNotificationRef.current) {
        onNotificationRef.current({
          type: data.type,
          title: data.title,
          message: data.message,
          path: data.path,
        });
      }
    });

    setSocket(newSocket);
    socketRef.current = newSocket;

    // Cleanup on unmount
    return () => {
      console.log('[Workstream] Disconnecting...');
      isManualDisconnect.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      newSocket.disconnect();
      socketRef.current = null;
    };
  }, [serverUrl, token, autoConnect]);

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
    isReconnecting,
    reconnectAttempt,
    error,
    refresh,
    manualReconnect,
  };
}
