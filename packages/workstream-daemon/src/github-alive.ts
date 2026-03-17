import { $ } from 'zx';

$.verbose = false;

interface GitHubAliveOptions {
  onNotification: (channelName: string, data: any) => void;
  onError?: (error: Error) => void;
}

const BACKOFF_SCHEDULE = [5000, 10000, 30000, 60000]; // 5s → 10s → 30s → 60s max

function log(...args: any[]) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}]`, '[GitHubAlive]', ...args);
}

export interface GitHubAliveStatus {
  connected: boolean;
  connectedAt: number | null;
  reconnectAttempts: number;
  messagesReceived: number;
  lastMessageAt: number | null;
  channelName: string | null;
  disabled: boolean;
}

export class GitHubAliveClient {
  private options: GitHubAliveOptions;
  private ws: WebSocket | null = null;
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt: number = 0;
  private stopped: boolean = false;
  private token: string | null = null;
  private _connectedAt: number | null = null;
  private _messagesReceived: number = 0;
  private _lastMessageAt: number | null = null;
  private _channelName: string | null = null;
  private _disabled: boolean = false;

  constructor(options: GitHubAliveOptions) {
    this.options = options;
  }

  getStatus(): GitHubAliveStatus {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      connectedAt: this._connectedAt,
      reconnectAttempts: this.reconnectAttempt,
      messagesReceived: this._messagesReceived,
      lastMessageAt: this._lastMessageAt,
      channelName: this._channelName,
      disabled: this._disabled,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;

    try {
      this.token = await this.getToken();
      if (!this.token) {
        log('⚠️  GitHub Desktop token not found — alive client disabled (polling fallback active)');
        this._disabled = true;
        return;
      }

      await this.connect();
    } catch (error) {
      log('⚠️  Failed to start:', (error as Error).message);
      this.options.onError?.(error as Error);
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }

    log('Stopped');
  }

  private async getToken(): Promise<string | null> {
    try {
      const result = await $`security find-generic-password -s "GitHub - https://api.github.com" -w`;
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async fetchWebSocketUrl(): Promise<string> {
    const result = await $`curl -sf -H ${'Authorization: token ' + this.token} https://api.github.com/alive_internal/websocket-url`;
    const data = JSON.parse(result.stdout.trim());
    const url = data.url;
    if (!url) {
      throw new Error('Empty WebSocket URL returned');
    }
    return url;
  }

  private async fetchAliveChannel(): Promise<{ channelName: string; signedChannel: string }> {
    const result = await $`curl -sf -H ${'Authorization: token ' + this.token} https://api.github.com/desktop_internal/alive-channel`;
    const data = JSON.parse(result.stdout.trim());
    if (!data.signed_channel || !data.channel_name) {
      throw new Error('Missing alive channel data');
    }
    return { channelName: data.channel_name, signedChannel: data.signed_channel };
  }

  private async connect(): Promise<void> {
    const [wssUrl, { channelName, signedChannel }] = await Promise.all([
      this.fetchWebSocketUrl(),
      this.fetchAliveChannel(),
    ]);

    log(`Connecting to ${wssUrl.substring(0, 60)}...`);

    this.ws = new WebSocket(wssUrl);

    this.ws.onopen = () => {
      log('✅ Connected');
      this.reconnectAttempt = 0;
      this._connectedAt = Date.now();
      this._channelName = channelName;

      // Subscribe to the alive channel
      const subscribeMsg = JSON.stringify({ subscribe: { channel: channelName, signed: signedChannel } });
      this.ws!.send(subscribeMsg);
      log(`Subscribed to channel: ${channelName}`);

      // Start keepalive pings every 30s
      this.startKeepalive();
    };

    this.ws.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString();

      try {
        if (raw === '' || raw === 'pong') return;

        const data = JSON.parse(raw);

        // Skip ack/health frames
        if (data.e === 'ack') return;

        this._messagesReceived++;
        this._lastMessageAt = Date.now();
        log('📩 Event:', raw.substring(0, 200));
        this.options.onNotification(channelName, data);
      } catch {
        // Non-JSON message, ignore (keepalive ack, etc.)
      }
    };

    this.ws.onerror = (event) => {
      const err = new Error(`WebSocket error: ${(event as any).message || 'unknown'}`);
      log('❌ Error:', err.message);
      this.options.onError?.(err);
    };

    this.ws.onclose = (event) => {
      log(`Connection closed: code=${event.code} reason=${event.reason || 'none'}`);
      this.stopKeepalive();
      this._connectedAt = null;
      this.ws = null;

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: true }));
      }
    }, 30000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = BACKOFF_SCHEDULE[Math.min(this.reconnectAttempt, BACKOFF_SCHEDULE.length - 1)];
    this.reconnectAttempt++;

    log(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped) return;

      try {
        // Re-fetch token in case it changed
        this.token = await this.getToken();
        if (!this.token) {
          log('⚠️  Token no longer available — stopping reconnect');
          return;
        }

        await this.connect();
      } catch (error) {
        log('Reconnect failed:', (error as Error).message);
        this.scheduleReconnect();
      }
    }, delay);
  }
}
