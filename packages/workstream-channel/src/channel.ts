#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  computeWorkspaceHash,
  registerInstance,
  refreshRegistration,
  deregisterInstance,
  subscribeToChannels,
  getPublisher,
  closeAll,
  REDIS_CHANNELS,
} from './redis.js';
import { filterAndFormat } from './events.js';
import { parseCommand, formatCommand } from './commands.js';
import type { FormattedEvent } from './events.js';

const workspacePath = process.cwd();
const workspaceHash = computeWorkspaceHash(workspacePath);

console.error(`[Channel] Workspace: ${workspacePath}`);
console.error(`[Channel] Hash: ${workspaceHash}`);

const server = new Server(
  { name: 'workstream', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Events from the workstream channel arrive as <channel source="workstream" ...>.

**Commands** (type="command"): These are instructions from the user sent through external tools (Raycast, CLI, HTTP API).
Execute the command as if the user typed it. The "command" attribute contains the action (e.g., "/fix-pr").
The tag body contains additional context. After completing a command, use the command_result tool to report the outcome.

**Notifications** (type="notification", "github", "worktree", "console_error", "git_change"):
Informational events from your development environment. Read and act if relevant to current work.
Use send_notification to push alerts back through the daemon.`,
  },
);

// Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_notification',
      description: 'Push a notification through the workstream daemon (appears in Raycast/system notifications)',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          message: { type: 'string', description: 'Notification body' },
          style: { type: 'string', enum: ['success', 'failure', 'info', 'warning'], description: 'Notification style' },
        },
        required: ['title', 'message'],
      },
    },
    {
      name: 'refresh_instances',
      description: 'Force the workstream daemon to re-poll all instances',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'command_result',
      description: 'Report the result of a command back to the originating client',
      inputSchema: {
        type: 'object',
        properties: {
          command_id: { type: 'string', description: 'The command_id from the original command event' },
          status: { type: 'string', enum: ['success', 'error'], description: 'Whether the command succeeded' },
          message: { type: 'string', description: 'Result description' },
        },
        required: ['command_id', 'status', 'message'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const publisher = getPublisher();

  try {
    switch (name) {
      case 'send_notification': {
        const { title, message, style } = args as { title: string; message: string; style?: string };
        await publisher.publish(
          REDIS_CHANNELS.NOTIFICATIONS,
          JSON.stringify({ title, message, style: style || 'info', source: 'claude-channel', timestamp: Date.now() }),
        );
        return { content: [{ type: 'text', text: `Notification sent: ${title}` }] };
      }

      case 'refresh_instances': {
        await publisher.publish(REDIS_CHANNELS.REFRESH, JSON.stringify({ source: 'claude-channel', timestamp: Date.now() }));
        return { content: [{ type: 'text', text: 'Refresh request sent to daemon' }] };
      }

      case 'command_result': {
        const { command_id, status, message } = args as { command_id: string; status: string; message: string };
        await publisher.publish(
          REDIS_CHANNELS.COMMAND_RESULTS,
          JSON.stringify({ command_id, status, message, workspace_hash: workspaceHash, timestamp: Date.now() }),
        );
        return { content: [{ type: 'text', text: `Command result reported: ${status}` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

function emitChannelEvent(event: FormattedEvent): void {
  const notification = {
    method: 'notifications/claude/channel' as const,
    params: {
      channel: 'workstream',
      attributes: event.attributes,
      content: event.content,
    },
  };

  try {
    server.notification(notification);
  } catch (err) {
    console.error('[Channel] Failed to emit notification:', err);
  }
}

function handleRedisMessage(channel: string, message: string): void {
  // Check if this is a command channel
  const isCommand =
    channel === REDIS_CHANNELS.COMMANDS_BROADCAST ||
    channel === REDIS_CHANNELS.COMMANDS_INSTANCE(workspaceHash);

  if (isCommand) {
    const cmd = parseCommand(message);
    if (!cmd) return;
    const formatted = formatCommand(cmd);
    if (formatted) {
      console.error(`[Channel] Command received: ${cmd.command} from ${cmd.source}`);
      emitChannelEvent(formatted);
    }
    return;
  }

  // Event channel
  const formatted = filterAndFormat(channel, message, workspacePath);
  if (formatted) {
    console.error(`[Channel] Event: ${formatted.type}`);
    emitChannelEvent(formatted);
  }
}

// Registration refresh interval
let refreshInterval: ReturnType<typeof setInterval> | null = null;

async function cleanup(): Promise<void> {
  if (refreshInterval) clearInterval(refreshInterval);
  try {
    await deregisterInstance(workspaceHash);
  } catch {
    // Best effort
  }
  await closeAll();
}

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

async function main(): Promise<void> {
  // Register this instance
  await registerInstance(workspaceHash, workspacePath);
  console.error('[Channel] Instance registered');

  // Refresh registration every 30s
  refreshInterval = setInterval(() => {
    refreshRegistration(workspaceHash).catch((err) =>
      console.error('[Channel] Registration refresh failed:', err),
    );
  }, 30_000);

  // Subscribe to Redis channels
  subscribeToChannels(workspaceHash, handleRedisMessage);

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Channel] MCP server started');
}

main().catch((error) => {
  console.error('[Channel] Fatal error:', error);
  process.exit(1);
});
