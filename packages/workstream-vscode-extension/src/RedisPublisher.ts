import Redis from 'ioredis';
import * as vscode from 'vscode';
import { Config } from './config';
import { WorkstreamEvent, VSCodeState } from './types';

export class RedisPublisher {
  private redis: Redis | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.text = '$(sync~spin) Workstream: Connecting...';
    this.statusBarItem.show();
  }

  async connect(): Promise<void> {
    if (!Config.enabled) {
      this.updateStatus('disabled');
      return;
    }

    try {
      this.redis = new Redis({
        host: Config.redisHost,
        port: Config.redisPort,
        retryStrategy: (times) => {
          if (times > this.maxReconnectAttempts) {
            this.updateStatus('failed');
            return null;
          }
          const delay = Math.min(times * 1000, 5000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.reconnectAttempts = 0;
        this.isConnected = true;
        this.updateStatus('connected');
        console.log('[Workstream] Connected to Redis');
      });

      this.redis.on('error', (err) => {
        console.error('[Workstream] Redis error:', err.message);
        this.isConnected = false;
        this.updateStatus('error');
      });

      this.redis.on('close', () => {
        this.isConnected = false;
        this.updateStatus('disconnected');
        console.log('[Workstream] Redis connection closed');
      });

      this.redis.on('reconnecting', () => {
        this.reconnectAttempts++;
        this.updateStatus('reconnecting');
        console.log(`[Workstream] Reconnecting to Redis (attempt ${this.reconnectAttempts})...`);
      });

      await this.redis.connect();
    } catch (error) {
      console.error('[Workstream] Failed to connect to Redis:', error);
      this.updateStatus('failed');
    }
  }

  async publishEvent(channel: string, event: WorkstreamEvent): Promise<void> {
    if (!this.isConnected || !this.redis) {
      return;
    }

    try {
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      console.error(`[Workstream] Failed to publish event to ${channel}:`, error);
    }
  }

  async publishState(workspacePath: string, state: VSCodeState): Promise<void> {
    if (!this.isConnected || !this.redis) {
      return;
    }

    try {
      const key = `workstream:vscode:state:${Buffer.from(workspacePath).toString('base64')}`;
      await this.redis.setex(key, 30, JSON.stringify(state));

      // Also publish heartbeat event
      await this.publishEvent('workstream:vscode:heartbeat', {
        type: 'heartbeat',
        workspacePath,
        timestamp: Date.now(),
        data: { extensionVersion: state.extensionVersion },
      });
    } catch (error) {
      console.error('[Workstream] Failed to publish state:', error);
    }
  }

  private updateStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'failed' | 'disabled' | 'error'): void {
    switch (status) {
      case 'connected':
        this.statusBarItem.text = '$(check) Workstream';
        this.statusBarItem.tooltip = 'Connected to workstream daemon';
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'disconnected':
        this.statusBarItem.text = '$(debug-disconnect) Workstream';
        this.statusBarItem.tooltip = 'Disconnected from Redis';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'reconnecting':
        this.statusBarItem.text = '$(sync~spin) Workstream';
        this.statusBarItem.tooltip = `Reconnecting... (attempt ${this.reconnectAttempts})`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'failed':
        this.statusBarItem.text = '$(error) Workstream';
        this.statusBarItem.tooltip = 'Failed to connect to Redis';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'disabled':
        this.statusBarItem.text = '$(circle-slash) Workstream';
        this.statusBarItem.tooltip = 'Workstream extension disabled';
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'error':
        this.statusBarItem.text = '$(warning) Workstream';
        this.statusBarItem.tooltip = 'Redis connection error';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  async dispose(): Promise<void> {
    this.statusBarItem.dispose();
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
