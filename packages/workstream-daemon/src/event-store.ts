import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

export interface WorkstreamEvent {
  id?: number;
  timestamp: number;
  channel: string;
  event_type: string;
  workspace_path: string | null;
  data: string; // JSON string
  created_at: number;
}

export interface FormattedEvent extends WorkstreamEvent {
  workspace_name?: string;
  relative_time?: string;
}

export class EventStore {
  private db: Database.Database;
  private workstreamDir: string;
  private maxEventsPerWorkspace: number;

  constructor(maxEventsPerWorkspace = 1000) {
    this.workstreamDir = join(homedir(), '.workstream');
    this.maxEventsPerWorkspace = maxEventsPerWorkspace;

    // Ensure workstream directory exists
    if (!existsSync(this.workstreamDir)) {
      mkdirSync(this.workstreamDir, { recursive: true });
    }

    const dbPath = join(this.workstreamDir, 'events.db');
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
    // Create events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        workspace_path TEXT,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace ON events(workspace_path);
      CREATE INDEX IF NOT EXISTS idx_channel ON events(channel);
      CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at DESC);
    `);
  }

  /**
   * Store a new event in the database
   */
  storeEvent(event: Omit<WorkstreamEvent, 'id' | 'created_at'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (timestamp, channel, event_type, workspace_path, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.timestamp,
      event.channel,
      event.event_type,
      event.workspace_path,
      event.data,
      Date.now()
    );

    // Cleanup old events for this workspace
    if (event.workspace_path) {
      this.cleanupOldEvents(event.workspace_path);
    }

    return result.lastInsertRowid as number;
  }

  /**
   * Remove old events to maintain retention policy
   */
  private cleanupOldEvents(workspacePath: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM events
      WHERE workspace_path = ?
      AND id NOT IN (
        SELECT id FROM events
        WHERE workspace_path = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);

    stmt.run(workspacePath, workspacePath, this.maxEventsPerWorkspace);
  }

  /**
   * Get recent events across all workspaces
   */
  getRecentEvents(limit = 100): WorkstreamEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit) as WorkstreamEvent[];
  }

  /**
   * Get events for a specific workspace
   */
  getEventsByWorkspace(workspacePath: string, limit = 100): WorkstreamEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE workspace_path = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(workspacePath, limit) as WorkstreamEvent[];
  }

  /**
   * Get events since a specific timestamp
   */
  getEventsSince(timestamp: number, limit = 100): WorkstreamEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(timestamp, limit) as WorkstreamEvent[];
  }

  /**
   * Get events by channel
   */
  getEventsByChannel(channel: string, limit = 100): WorkstreamEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE channel = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(channel, limit) as WorkstreamEvent[];
  }

  /**
   * Get events by event type
   */
  getEventsByType(eventType: string, limit = 100): WorkstreamEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE event_type = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(eventType, limit) as WorkstreamEvent[];
  }

  /**
   * Get events grouped by workspace
   */
  getEventsGroupedByWorkspace(limit = 100): Map<string, WorkstreamEvent[]> {
    const events = this.getRecentEvents(limit);
    const grouped = new Map<string, WorkstreamEvent[]>();

    for (const event of events) {
      const workspace = event.workspace_path || 'global';
      if (!grouped.has(workspace)) {
        grouped.set(workspace, []);
      }
      grouped.get(workspace)!.push(event);
    }

    return grouped;
  }

  /**
   * Get count of events by workspace
   */
  getEventCountByWorkspace(): Map<string, number> {
    const stmt = this.db.prepare(`
      SELECT workspace_path, COUNT(*) as count
      FROM events
      GROUP BY workspace_path
    `);

    const results = stmt.all() as Array<{ workspace_path: string | null; count: number }>;
    const counts = new Map<string, number>();

    for (const result of results) {
      counts.set(result.workspace_path || 'global', result.count);
    }

    return counts;
  }

  /**
   * Delete all events (useful for testing)
   */
  clearAllEvents(): void {
    this.db.exec('DELETE FROM events');
  }

  /**
   * Delete events older than a specific timestamp
   */
  deleteEventsBefore(timestamp: number): number {
    const stmt = this.db.prepare('DELETE FROM events WHERE timestamp < ?');
    const result = stmt.run(timestamp);
    return result.changes;
  }

  /**
   * Get database stats
   */
  getStats(): {
    totalEvents: number;
    oldestEvent: number | null;
    newestEvent: number | null;
    workspaceCount: number;
  } {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM events');
    const totalResult = totalStmt.get() as { count: number };

    const rangeStmt = this.db.prepare(`
      SELECT
        MIN(timestamp) as oldest,
        MAX(timestamp) as newest
      FROM events
    `);
    const rangeResult = rangeStmt.get() as { oldest: number | null; newest: number | null };

    const workspaceStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT workspace_path) as count
      FROM events
      WHERE workspace_path IS NOT NULL
    `);
    const workspaceResult = workspaceStmt.get() as { count: number };

    return {
      totalEvents: totalResult.count,
      oldestEvent: rangeResult.oldest,
      newestEvent: rangeResult.newest,
      workspaceCount: workspaceResult.count,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let eventStore: EventStore | null = null;

export function getEventStore(): EventStore {
  if (!eventStore) {
    eventStore = new EventStore();
  }
  return eventStore;
}

export function closeEventStore(): void {
  if (eventStore) {
    eventStore.close();
    eventStore = null;
  }
}
