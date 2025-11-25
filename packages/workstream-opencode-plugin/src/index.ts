/**
 * Workstream OpenCode Plugin
 * 
 * Integrates OpenCode with Workstream for enhanced development workflow
 * Replicates Claude Code behavior for Raycast/notifications
 */

import { initRedis, closeRedis, getPublisher } from './redis-client.ts';
import { publishEvent, publishNotification } from './event-publisher.ts';
import { SessionTracker } from './session-tracker.ts';
import { SafetyGuards } from './safety-guards.ts';
import { CommandListener } from './command-listener.ts';
import { ContextInjector } from './context-injector.ts';
import { ApiServer, type OpenCodeApiStatus } from './api-server.ts';
import { workstreamTools } from './tools/index.ts';
import { loadConfig } from './config.ts';
import type { PluginContext, WorkstreamPluginConfig } from './types.ts';

// Redis channel for OpenCode events (same as daemon uses)
const REDIS_CHANNEL_OPENCODE = 'workstream:opencode';

/**
 * Publish a status_changed event to trigger immediate daemon polling
 * This should be called IMMEDIATELY when state changes (not debounced)
 * The daemon will poll our API server to get the authoritative status
 */
async function publishStatusChanged(
  newStatus: 'working' | 'waiting' | 'idle',
  directory: string,
  sessionId: string | null
) {
  try {
    const publisher = getPublisher();
    
    await publisher.publish(
      REDIS_CHANNEL_OPENCODE,
      JSON.stringify({
        type: 'opencode_status_changed',
        timestamp: Date.now(),
        path: directory,
        sessionId,
        newStatus,
        pid: process.pid,
        source: 'opencode',
      })
    );
  } catch (error) {
    // Silent fail
  }
}

/**
 * Publish OpenCode status event (matches Claude event format)
 * This can be debounced for notifications, but status_changed should be called separately
 */
async function publishOpenCodeStatus(
  type: 'work_started' | 'waiting_for_input' | 'work_stopped',
  directory: string,
  sessionId: string | null,
  config: WorkstreamPluginConfig
) {
  try {
    const publisher = getPublisher();
    const projectName = directory.split('/').pop() || 'project';
    
    // Publish to OpenCode channel
    await publisher.publish(
      REDIS_CHANNEL_OPENCODE,
      JSON.stringify({
        type: `opencode_${type}`,
        timestamp: Date.now(),
        path: directory,
        sessionId,
        source: 'opencode',
      })
    );
    
    // Also publish notification for system notifications
    if (config.features.notifications) {
      let title = 'OpenCode';
      let message = '';
      let style: 'success' | 'failure' | 'info' = 'info';
      
      switch (type) {
        case 'work_started':
          message = `Working in ${projectName}`;
          break;
        case 'waiting_for_input':
          title = 'OpenCode';
          message = `Waiting for input in ${projectName}`;
          style = 'info';
          break;
        case 'work_stopped':
          title = 'OpenCode';
          message = `Finished in ${projectName}`;
          style = 'success';
          break;
      }
      
      await publishNotification(title, message, `opencode_${type}`, style, directory);
    }
  } catch (error) {
    // Silent fail
  }
}

/**
 * Main plugin export
 */
export const WorkstreamPlugin = async ({ project, client, $, directory, worktree }: PluginContext) => {

  // Load configuration
  const config = await loadConfig(directory);
  
  // Initialize Redis
  await initRedis(config.redis);
  
  // Initialize components
  const sessionTracker = new SessionTracker(config);
  const safetyGuards = new SafetyGuards(config);
  const commandListener = new CommandListener();
  const contextInjector = new ContextInjector();
  
  // Track current session and state
  let currentSessionId: string | null = null;
  let isWorking = false;
  let isWaiting = false; // Explicit waiting for input state
  let isIdle = true; // Not working and not waiting
  let workStartedAt: number | null = null;
  let lastActivityTime = Date.now();
  let idleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastPublishedStatus: 'working' | 'waiting' | 'idle' | null = null;
  const IDLE_DEBOUNCE_MS = 2000; // Wait 2 seconds before marking as idle/waiting
  const HEARTBEAT_INTERVAL_MS = 5000; // Send heartbeat every 5 seconds
  
  // Metrics tracking
  const metrics = {
    toolsUsed: {} as Record<string, number>,
    filesEdited: 0,
    commandsRun: 0,
  };
  
  // API Server for daemon polling
  const apiServer = new ApiServer(directory, (): OpenCodeApiStatus => {
    // Determine current status
    let status: OpenCodeApiStatus['status'] = 'idle';
    if (isWorking) {
      status = 'working';
    } else if (isWaiting) {
      status = 'waiting';
    } else if (isIdle) {
      status = 'idle';
    }
    
    return {
      sessionId: currentSessionId,
      workspacePath: directory,
      projectName: directory.split('/').pop() || 'project',
      pid: process.pid,
      status,
      isWorking,
      isWaiting,
      isIdle,
      lastActivityTime,
      workStartedAt,
      metrics,
    };
  });
  
  // Start API server (silent - daemon will log when it connects)
  try {
    await apiServer.start();
  } catch (error) {
    // Silent fail - API server is optional enhancement
  }

  // Start command listener for bi-directional control
  if (config.features.biDirectionalControl) {
    await commandListener.start(directory);
    
    commandListener.onCommand('pause', async (command) => {
      // TODO: Implement session pause logic when OpenCode API supports it
    });
    
    commandListener.onCommand('resume', async (command) => {
      // TODO: Implement session resume logic when OpenCode API supports it
    });
    
    commandListener.onCommand('inject_context', async (command) => {
      // TODO: Inject context into current session when OpenCode API supports it
    });
    
    commandListener.onCommand('get_status', async (command) => {
      // TODO: Return session status when OpenCode API supports it
    });
  }

  // Send startup notification
  const projectName = directory.split('/').pop() || 'project';
  await publishNotification(
    'OpenCode',
    `Started in ${projectName}`,
    'opencode_session_started',
    'info',
    directory
  );

  // Heartbeat function - publishes current status without notification
  async function sendHeartbeat() {
    try {
      const publisher = getPublisher();
      // Correctly determine status based on all state flags
      const currentStatus = isWorking ? 'working' : isWaiting ? 'waiting' : 'idle';
      
      // Always send heartbeat to keep daemon updated
      await publisher.publish(
        REDIS_CHANNEL_OPENCODE,
        JSON.stringify({
          type: 'opencode_heartbeat',
          timestamp: Date.now(),
          path: directory,
          sessionId: currentSessionId,
          status: currentStatus,
          isWorking,
          isWaiting,
          isIdle,
          lastActivityTime,
        })
      );
    } catch (error) {
      // Silent fail - heartbeat is non-critical
    }
  }

  // Start heartbeat timer
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // ==========================================================================
  // EVENT HANDLERS (called from main event hook)
  // ==========================================================================
  
  async function handleSessionCreated(properties: any) {
    if (!config.features.eventTracking) return;
    
    currentSessionId = properties.info?.id || properties.sessionId;
    isWorking = false;
    isWaiting = false;
    isIdle = true;
    lastActivityTime = Date.now();
    workStartedAt = null;
    
    // Reset metrics
    metrics.toolsUsed = {};
    metrics.filesEdited = 0;
    metrics.commandsRun = 0;
    
    if (currentSessionId) {
      await sessionTracker.startSession(currentSessionId, directory);
    }
    
    // Publish session created event
    await publishEvent('opencode_session_created', directory, {
      sessionId: currentSessionId,
    });
  }

  async function handleSessionStatus(properties: any) {
    if (!config.features.eventTracking) return;
    
    const { sessionID, status } = properties;
    
    // Only handle events for our session or if we don't have one yet
    if (currentSessionId && sessionID !== currentSessionId) return;
    
    if (status.type === 'idle') {
      // Capture if we were working before this idle event
      const wasWorking = isWorking;
      
      // Update state IMMEDIATELY so API server returns correct status
      // "idle" means finished and at prompt - NOT waiting for permission
      // "waiting" is ONLY set by permission.ask hook
      isWorking = false;
      isWaiting = false;  // Only permission.ask sets this to true
      isIdle = true;
      lastActivityTime = Date.now();
      
      // Publish status_changed IMMEDIATELY for near real-time daemon updates
      await publishStatusChanged('idle', directory, currentSessionId);
      
      // Clear any existing debounce timer
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
      }
      
      // Debounce the detailed event publishing
      idleDebounceTimer = setTimeout(async () => {
        if (currentSessionId) {
          const session = sessionTracker.getSession(currentSessionId);
          if (session) {
            await publishEvent('opencode_session_idle', directory, {
              sessionId: currentSessionId,
              duration: Date.now() - session.startTime,
              metrics: session.metrics,
              wasWorking,
            });
          }
        }
      }, IDLE_DEBOUNCE_MS);
      
    } else if (status.type === 'busy') {
      // Cancel any pending idle transition
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
        idleDebounceTimer = null;
      }
      
      if (!isWorking) {
        isWorking = true;
        isWaiting = false;
        isIdle = false;
        lastActivityTime = Date.now();
        if (!workStartedAt) {
          workStartedAt = Date.now();
        }
        
        await publishStatusChanged('working', directory, currentSessionId);
        await publishOpenCodeStatus('work_started', directory, currentSessionId, config);
      }
    }
  }

  async function handleSessionIdle(properties: any) {
    // This is the deprecated event but still fires - use it as backup
    if (!config.features.eventTracking) return;
    
    const { sessionID } = properties;
    if (currentSessionId && sessionID !== currentSessionId) return;
    
    // Only process if we haven't already handled via session.status
    if (isWorking) {
      const wasWorking = true;
      isWorking = false;
      isWaiting = false;  // Only permission.ask sets this to true
      isIdle = true;
      lastActivityTime = Date.now();
      
      await publishStatusChanged('idle', directory, currentSessionId);
      
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
      }
      
      idleDebounceTimer = setTimeout(async () => {
        if (currentSessionId) {
          const session = sessionTracker.getSession(currentSessionId);
          if (session) {
            await publishEvent('opencode_session_idle', directory, {
              sessionId: currentSessionId,
              duration: Date.now() - session.startTime,
              metrics: session.metrics,
              wasWorking,
            });
          }
        }
      }, IDLE_DEBOUNCE_MS);
    }
  }

  async function handleSessionError(properties: any) {
    if (!config.features.eventTracking) return;
    
    isWorking = false;
    isWaiting = false;
    isIdle = true;
    
    if (currentSessionId) {
      await sessionTracker.updateActivity(currentSessionId, {
        error: true,
      });
    }
    
    await publishEvent('opencode_session_error', directory, {
      sessionId: currentSessionId,
      error: properties.error,
    });
    
    const projectName = directory.split('/').pop() || 'project';
    if (config.features.notifications) {
      await publishNotification(
        'OpenCode Error',
        `Error in ${projectName}: ${properties.error?.message || 'Unknown error'}`,
        'opencode_error',
        'failure',
        directory
      );
    }
  }

  async function handleSessionCompacted(properties: any) {
    if (!config.features.eventTracking) return;
    
    if (currentSessionId) {
      await sessionTracker.markCompacting(currentSessionId);
    }
    
    await publishEvent('opencode_session_compacting', directory, {
      sessionId: currentSessionId,
    });
  }

  async function handleSessionDeleted(properties: any) {
    if (!config.features.eventTracking) return;
    
    isWorking = false;
    isWaiting = false;
    isIdle = true;
    workStartedAt = null;
    lastActivityTime = Date.now();
    
    await publishStatusChanged('idle', directory, currentSessionId);
    
    if (currentSessionId) {
      await publishOpenCodeStatus('work_stopped', directory, currentSessionId, config);
    }
    
    currentSessionId = null;
  }

  async function handleFileEdited(properties: any) {
    if (!config.features.eventTracking || !currentSessionId) return;

    await publishEvent('opencode_file_edited', directory, {
      sessionId: currentSessionId,
      filePath: properties.file,
    });
  }

  return {
    // ==========================================================================
    // MAIN EVENT HOOK - OpenCode calls this for ALL events
    // ==========================================================================
    
    event: async ({ event }: { event: { type: string; properties: any } }) => {
      const { type, properties } = event;
      
      switch (type) {
        case 'session.created':
          await handleSessionCreated(properties);
          break;
        case 'session.status':
          await handleSessionStatus(properties);
          break;
        case 'session.idle':
          await handleSessionIdle(properties);
          break;
        case 'session.error':
          await handleSessionError(properties);
          break;
        case 'session.compacted':
          await handleSessionCompacted(properties);
          break;
        case 'session.deleted':
          await handleSessionDeleted(properties);
          break;
        case 'file.edited':
          await handleFileEdited(properties);
          break;
        case 'permission.updated':
          // Permission state updated - just update our state, no notification
          // (notification is handled by permission.ask hook)
          isWorking = false;
          isWaiting = true;
          isIdle = false;
          lastActivityTime = Date.now();
          await publishStatusChanged('waiting', directory, currentSessionId);
          break;
      }
    },

    // ==========================================================================
    // TOOL HOOKS - These ARE called directly by OpenCode
    // ==========================================================================

    "tool.execute.before": async (input: any, output: any) => {
      // Cancel any pending idle transition - we're working again
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
        idleDebounceTimer = null;
      }
      
      // Mark as working when any tool starts executing
      if (!isWorking) {
        isWorking = true;
        isWaiting = false;
        isIdle = false;
        lastActivityTime = Date.now();
        if (!workStartedAt) {
          workStartedAt = Date.now();
        }
        
        // Publish status_changed IMMEDIATELY for near real-time daemon updates
        await publishStatusChanged('working', directory, currentSessionId);
        
        // Also publish the full event (with notifications)
        await publishOpenCodeStatus('work_started', directory, currentSessionId, config);
      }

      if (!currentSessionId) return;

      // Safety checks
      if (config.features.safetyGuards) {
        const session = sessionTracker.getSession(currentSessionId);
        if (session) {
          const safetyCheck = await safetyGuards.checkSafety({
            tool: input.tool,
            args: output.args,
            workspacePath: directory,
            git: session.git,
            session,
          });

          if (!safetyCheck.allowed) {
            throw new Error(`Safety check failed:\n${safetyCheck.blocked.join('\n')}`);
          }
        }
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!config.features.eventTracking || !currentSessionId) return;

      const tool = input.tool;
      lastActivityTime = Date.now();
      
      // Update local metrics
      metrics.toolsUsed[tool] = (metrics.toolsUsed[tool] || 0) + 1;
      if (tool === 'bash') {
        metrics.commandsRun++;
      } else if (tool === 'write' || tool === 'edit') {
        metrics.filesEdited++;
      }
      
      // Update session activity
      await sessionTracker.updateActivity(currentSessionId, {
        tool,
        fileEdited: tool === 'write' || tool === 'edit',
        commandRun: tool === 'bash',
      });

      // Publish specific tool events
      const eventType = `opencode_tool_${tool}` as any;
      await publishEvent(eventType, directory, {
        sessionId: currentSessionId,
        tool,
        args: input.args,
        success: !output.error,
      });
    },

    // ==========================================================================
    // PERMISSION HOOK
    // ==========================================================================
    
    "permission.ask": async (input: any, output: any) => {
      if (!config.features.notifications) return;
      
      const projectName = directory.split('/').pop() || 'project';
      // Permission.Info: { id, type, title, pattern, metadata, sessionID, messageID, callID, time }
      const tool = input?.type || 'unknown';  // e.g., "bash", "write", "edit"
      const title = input?.title || '';       // e.g., the command or file path
      
      // Truncate long titles for notification (e.g., long bash commands)
      const shortTitle = title.length > 60 ? title.substring(0, 57) + '...' : title;
      
      // Update state - we're waiting for permission
      isWorking = false;
      isWaiting = true;
      isIdle = false;
      lastActivityTime = Date.now();
      
      // Publish status change immediately
      await publishStatusChanged('waiting', directory, currentSessionId);
      
      // Publish permission event
      await publishEvent('opencode_permission_requested', directory, {
        sessionId: currentSessionId,
        tool,
        title,
        pattern: input?.pattern,
        metadata: input?.metadata,
      });
      
      // Send notification - make it clear permission is needed
      await publishNotification(
        `Permission Required`,
        `${projectName} needs approval for ${tool}: ${shortTitle}`,
        'opencode_permission_requested',
        'info',
        directory
      );
    },

    // ==========================================================================
    // CHAT HOOKS
    // ==========================================================================
    
    "chat.message": async (input: any, output: any) => {
      if (!config.features.contextInjection) return;
      
      try {
        await contextInjector.getPRSuggestions(directory);
      } catch (error) {
        // Silent fail
      }
    },

    // ==========================================================================
    // CUSTOM TOOLS
    // ==========================================================================

    tool: config.features.customTools ? workstreamTools : undefined,

    // ==========================================================================
    // CLEANUP
    // ==========================================================================

    dispose: async () => {
      // Clear any pending timers
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
        idleDebounceTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      
      // Stop API server
      await apiServer.stop();
      
      // Publish work_stopped on dispose
      if (isWorking || currentSessionId) {
        await publishOpenCodeStatus('work_stopped', directory, currentSessionId, config);
      }
      
      sessionTracker.dispose();
      await commandListener.stop();
      await closeRedis();
    },
  };
};

// Export the plugin as default
export default WorkstreamPlugin;
