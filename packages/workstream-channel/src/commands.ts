import type { WorkstreamCommand } from './types.js';
import type { FormattedEvent } from './events.js';

const recentCommandIds = new Set<string>();
const COMMAND_DEDUP_MAX = 50;

function sanitizeContent(text: string): string {
  return text.replace(/<\/?channel[^>]*>/gi, '[channel]');
}

export function parseCommand(rawMessage: string): WorkstreamCommand | null {
  try {
    const data = JSON.parse(rawMessage);
    if (!data.command || !data.id) return null;
    return {
      command: data.command,
      context: data.context,
      source: data.source || 'unknown',
      id: data.id,
    };
  } catch {
    return null;
  }
}

export function formatCommand(cmd: WorkstreamCommand): FormattedEvent | null {
  // Dedup by command ID
  if (recentCommandIds.has(cmd.id)) return null;
  recentCommandIds.add(cmd.id);
  if (recentCommandIds.size > COMMAND_DEDUP_MAX) {
    const first = recentCommandIds.values().next().value;
    if (first) recentCommandIds.delete(first);
  }

  // Build human-readable content from command + context
  let content = cmd.command;
  if (cmd.context && Object.keys(cmd.context).length > 0) {
    const contextParts = Object.entries(cmd.context)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    content += `\n\nContext: ${contextParts}`;
  }

  return {
    type: 'command',
    attributes: {
      source: 'workstream',
      type: 'command',
      command: cmd.command,
      source_client: cmd.source,
      command_id: cmd.id,
    },
    content: sanitizeContent(content),
  };
}
