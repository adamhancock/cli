import { getRedisClient } from './redis-client.ts';
import { publishEvent, publishNotification } from './event-publisher.ts';
import { REDIS_KEYS, type OpenCodeSession, type WorkstreamPluginConfig } from './types.ts';

export class SessionTracker {
  private sessions: Map<string, OpenCodeSession> = new Map();
  private config: WorkstreamPluginConfig;
  private idleCheckInterval?: NodeJS.Timeout;
  private readonly IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

  constructor(config: WorkstreamPluginConfig) {
    this.config = config;
  }

  /**
   * Start tracking a new session
   */
  async startSession(sessionId: string, workspacePath: string): Promise<void> {
    const projectName = workspacePath.split('/').pop() || 'unknown';
    
    const session: OpenCodeSession = {
      sessionId,
      workspacePath,
      projectName,
      startTime: Date.now(),
      lastActivity: Date.now(),
      status: 'active',
      metrics: {
        toolsUsed: {},
        filesEdited: 0,
        commandsRun: 0,
        errorsEncountered: 0,
        tokensUsed: 0,
        estimatedCost: 0,
        duration: 0,
      },
    };

    this.sessions.set(sessionId, session);

    // Save to Redis
    await this.saveSession(session);

    // Publish event
    await publishEvent('opencode_session_created', workspacePath, {
      sessionId,
      projectName,
    });

    // Start idle checking
    this.startIdleCheck();
  }

  /**
   * Update session activity
   */
  async updateActivity(sessionId: string, data: {
    tool?: string;
    fileEdited?: boolean;
    commandRun?: boolean;
    error?: boolean;
    tokens?: number;
    cost?: number;
  }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();
    session.status = 'active';

    // Update metrics
    if (data.tool) {
      session.metrics.toolsUsed[data.tool] = (session.metrics.toolsUsed[data.tool] || 0) + 1;
    }
    if (data.fileEdited) {
      session.metrics.filesEdited++;
    }
    if (data.commandRun) {
      session.metrics.commandsRun++;
    }
    if (data.error) {
      session.metrics.errorsEncountered++;
    }
    if (data.tokens) {
      session.metrics.tokensUsed += data.tokens;
    }
    if (data.cost) {
      session.metrics.estimatedCost += data.cost;
    }

    session.metrics.duration = Date.now() - session.startTime;

    // Check thresholds
    await this.checkThresholds(session);

    // Save to Redis
    await this.saveSession(session);

    // Publish active event
    await publishEvent('opencode_session_active', session.workspacePath, {
      sessionId: session.sessionId,
      metrics: session.metrics,
    });
  }

  /**
   * Mark session as compacting
   */
  async markCompacting(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'compacting';
    await this.saveSession(session);

    await publishEvent('opencode_session_compacting', session.workspacePath, {
      sessionId,
    });
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): OpenCodeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions for a workspace
   */
  getSessionsByWorkspace(workspacePath: string): OpenCodeSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.workspacePath === workspacePath
    );
  }

  /**
   * Check for idle sessions
   */
  private startIdleCheck(): void {
    if (this.idleCheckInterval) return;

    this.idleCheckInterval = setInterval(async () => {
      const now = Date.now();

      for (const [sessionId, session] of this.sessions) {
        if (session.status === 'active') {
          const idleTime = now - session.lastActivity;

          if (idleTime > this.IDLE_THRESHOLD) {
            session.status = 'idle';
            await this.saveSession(session);

            await publishEvent('opencode_session_idle', session.workspacePath, {
              sessionId,
              idleTime: Math.round(idleTime / 1000),
            });

            if (this.config.notifications.onSessionIdle) {
              await publishNotification(
                'OpenCode Idle',
                `Session idle for ${Math.round(idleTime / 60000)} minutes in ${session.projectName}`,
                'opencode_idle',
                'info',
                session.workspacePath
              );
            }
          }
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Check analytics thresholds
   */
  private async checkThresholds(session: OpenCodeSession): Promise<void> {
    // Cost threshold
    if (
      session.metrics.estimatedCost >= this.config.analytics.costThreshold &&
      this.config.notifications.onCostThreshold
    ) {
      await publishNotification(
        'OpenCode Cost Alert',
        `Session has reached $${session.metrics.estimatedCost.toFixed(2)} in ${session.projectName}`,
        'opencode_cost_threshold',
        'info',
        session.workspacePath
      );
    }

    // Time threshold
    const duration = session.metrics.duration / (1000 * 60); // minutes
    if (duration >= this.config.analytics.timeThreshold) {
      await publishEvent('opencode_time_threshold', session.workspacePath, {
        sessionId: session.sessionId,
        duration,
      });
    }

    // Error threshold
    if (
      session.metrics.errorsEncountered >= this.config.analytics.errorThreshold &&
      this.config.notifications.onError
    ) {
      await publishNotification(
        'OpenCode Error Alert',
        `${session.metrics.errorsEncountered} errors in ${session.projectName}`,
        'opencode_error_threshold',
        'failure',
        session.workspacePath
      );
    }
  }

  /**
   * Save session to Redis
   */
  private async saveSession(session: OpenCodeSession): Promise<void> {
    try {
      const redis = getRedisClient();
      const key = REDIS_KEYS.OPENCODE_SESSION(session.sessionId);
      await redis.set(key, JSON.stringify(session), 'EX', 3600); // 1 hour TTL
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }
  }
}
