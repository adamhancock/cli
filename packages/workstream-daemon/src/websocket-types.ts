/**
 * WebSocket message types for workstream-daemon
 * Port: 9995
 */

// Client → Server messages
export interface ClientToServerEvents {
  subscribe: () => void;
  'get-instances': () => void;
  ping: () => void;
}

// Server → Client messages
export interface ServerToClientEvents {
  instances: (instances: any[]) => void;
  'instance-updated': (instance: any) => void;
  'claude-event': (data: ClaudeEventData) => void;
  notification: (data: NotificationData) => void;
  pong: () => void;
}

export interface ClaudeEventData {
  path: string;
  type: 'work_started' | 'waiting_for_input' | 'work_stopped';
  pid?: number;
  terminalName?: string;
  terminalId?: string;
  terminalPid?: number;
  vscodePid?: number;
  timestamp: number;
}

export interface NotificationData {
  type: string;
  title: string;
  message: string;
  path?: string;
  timestamp: number;
}
