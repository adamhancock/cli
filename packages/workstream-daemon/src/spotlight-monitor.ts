import EventSource from 'eventsource';
import http from 'http';

interface SpotlightCounts {
  errors: number;
  traces: number;
  logs: number;
  lastUpdated: number;
}

interface SpotlightConnection {
  port: number;
  eventSource: EventSource;
  counts: SpotlightCounts;
}

export class SpotlightMonitor {
  private connections: Map<string, SpotlightConnection> = new Map();

  /**
   * Check if spotlight port is online
   */
  async checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: 'localhost',
          port: port,
          path: '/',
          timeout: 2000,
        },
        (res) => {
          // Any response means it's online
          resolve(true);
          res.resume(); // Drain response
        }
      );

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Get current counts for an instance
   */
  getCounts(instancePath: string): SpotlightCounts | null {
    const connection = this.connections.get(instancePath);
    if (!connection) return null;
    return connection.counts;
  }

  /**
   * Connect to spotlight SSE stream for an instance
   */
  connectStream(port: number, instancePath: string): void {
    // Close existing connection if any
    this.disconnectStream(instancePath);

    const url = `http://localhost:${port}/stream?base64=1&client=spotlight-overlay`;
    const instanceName = instancePath.split('/').pop() || instancePath;
    console.log(`[SpotlightMonitor] Connecting to ${url} for ${instanceName}`);

    const eventSource = new EventSource(url);

    const connection: SpotlightConnection = {
      port,
      eventSource,
      counts: {
        errors: 0,
        traces: 0,
        logs: 0,
        lastUpdated: Date.now(),
      },
    };

    eventSource.onopen = () => {
      console.log(`[SpotlightMonitor] Stream opened for ${instanceName} on port ${port}`);
    };

    // Listen for the Sentry envelope event type
    eventSource.addEventListener('application/x-sentry-envelope;base64', (event: any) => {
      try {
        console.log(`[SpotlightMonitor] Received Sentry envelope for ${instanceName}, data length: ${event.data?.length || 0}`);
        this.handleStreamEvent(event.data, connection.counts, instanceName);
      } catch (error) {
        console.error(`[SpotlightMonitor] Failed to parse event for ${instanceName}:`, error);
      }
    });

    // Also listen for default message events as fallback
    eventSource.onmessage = (event) => {
      try {
        console.log(`[SpotlightMonitor] Received default message event for ${instanceName}, data length: ${event.data?.length || 0}`);
        this.handleStreamEvent(event.data, connection.counts, instanceName);
      } catch (error) {
        console.error(`[SpotlightMonitor] Failed to parse default event for ${instanceName}:`, error);
      }
    };

    eventSource.onerror = (error) => {
      console.error(`[SpotlightMonitor] SSE error for ${instanceName} (port ${port}):`, error);
      // EventSource will auto-reconnect, but we log the error
    };

    this.connections.set(instancePath, connection);
    console.log(`[SpotlightMonitor] Connected to spotlight stream for ${instanceName} on port ${port}`);
  }

  /**
   * Disconnect spotlight stream for an instance
   */
  disconnectStream(instancePath: string): void {
    const connection = this.connections.get(instancePath);
    if (connection) {
      connection.eventSource.close();
      this.connections.delete(instancePath);
      console.log(`[SpotlightMonitor] Disconnected spotlight stream for ${instancePath}`);
    }
  }

  /**
   * Disconnect all streams
   */
  disconnectAll(): void {
    for (const [instancePath, connection] of this.connections.entries()) {
      connection.eventSource.close();
      console.log(`[SpotlightMonitor] Disconnected spotlight stream for ${instancePath}`);
    }
    this.connections.clear();
  }

  /**
   * Get all connected instance paths
   */
  getConnectedInstances(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if an instance is connected
   */
  isConnected(instancePath: string): boolean {
    return this.connections.has(instancePath);
  }

  /**
   * Parse Sentry envelope and update counts
   */
  private handleStreamEvent(data: string, counts: SpotlightCounts, instanceName: string): void {
    try {
      // Parse the Sentry envelope - it's a JSON array: [{headers}, [[{item_header}, {item_data}]]]
      const envelope = JSON.parse(data);

      if (!Array.isArray(envelope) || envelope.length < 2) {
        console.log(`[SpotlightMonitor] ${instanceName}: Invalid envelope format`);
        return;
      }

      // First element is headers, second element is array of items
      const items = envelope[1];

      if (!Array.isArray(items)) {
        console.log(`[SpotlightMonitor] ${instanceName}: Items is not an array`);
        return;
      }

      let eventsParsed = 0;
      for (const item of items) {
        if (!Array.isArray(item) || item.length < 2) continue;

        const [itemHeader, itemData] = item;
        eventsParsed++;

        // Check the type field in the item header
        if (itemHeader.type === 'transaction') {
          counts.traces++;
          console.log(`[SpotlightMonitor] ${instanceName}: Transaction event (total traces: ${counts.traces})`);
        } else if (itemHeader.type === 'event') {
          // Check if it's an error by looking at level in the item data
          if (itemData.level === 'error' || itemData.level === 'fatal') {
            counts.errors++;
            console.log(`[SpotlightMonitor] ${instanceName}: Error event (total errors: ${counts.errors})`);
          } else {
            // Otherwise treat as log
            counts.logs++;
            console.log(`[SpotlightMonitor] ${instanceName}: Log event (total logs: ${counts.logs})`);
          }
        } else if (itemHeader.type === 'span') {
          counts.traces++;
          console.log(`[SpotlightMonitor] ${instanceName}: Span event (total traces: ${counts.traces})`);
        } else {
          console.log(`[SpotlightMonitor] ${instanceName}: Unknown event type: ${itemHeader.type}`);
        }

        counts.lastUpdated = Date.now();
      }

      console.log(`[SpotlightMonitor] ${instanceName}: Parsed ${eventsParsed} events. Current counts - E:${counts.errors} T:${counts.traces} L:${counts.logs}`);
    } catch (error) {
      console.error(`[SpotlightMonitor] ${instanceName}: Failed to handle stream event:`, error);
    }
  }
}

// Singleton instance
export const spotlightMonitor = new SpotlightMonitor();
