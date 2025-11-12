#!/bin/bash

# Claude hook script to notify workstream daemon
# Automatically determines event type from hook context

DAEMON_WS="ws://localhost:58234"

# Read JSON context from stdin (provided by Claude hooks)
CONTEXT=$(cat)

# Extract hook event name and tool name from context
HOOK_EVENT=$(echo "$CONTEXT" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
TOOL_NAME=$(echo "$CONTEXT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)

# Map hook event to daemon event type
case "$HOOK_EVENT" in
  UserPromptSubmit)
    EVENT_TYPE="work_started"
    ;;
  PreToolUse)
    # Check if this is a waiting tool
    if [ "$TOOL_NAME" = "AskUserQuestion" ] || [ "$TOOL_NAME" = "ExitPlanMode" ]; then
      EVENT_TYPE="waiting_for_input"
    else
      EVENT_TYPE="work_started"
    fi
    ;;
  Stop)
    EVENT_TYPE="work_stopped"
    ;;
  *)
    # Fallback: use argument if provided
    EVENT_TYPE="${1:-work_started}"
    ;;
esac

# Extract project directory from environment variable (set by Claude)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Debug logging (optional, uncomment to enable)
# echo "[$(date '+%Y-%m-%d %H:%M:%S')] $HOOK_EVENT -> $EVENT_TYPE ($TOOL_NAME) in $PROJECT_DIR" >> /tmp/claude-hook-debug.log

# Send event to daemon via WebSocket
# Using websocat if available, otherwise try curl websocket upgrade
if command -v websocat &> /dev/null; then
    echo "{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\"}" | websocat "$DAEMON_WS" 2>/dev/null || true
elif command -v wscat &> /dev/null; then
    echo "{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\"}" | wscat -c "$DAEMON_WS" 2>/dev/null || true
else
    # Fallback: try with node if available
    if command -v node &> /dev/null; then
        node -e "
        const WebSocket = require('ws');
        const ws = new WebSocket('$DAEMON_WS');
        ws.on('open', () => {
            ws.send('{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\"}');
            ws.close();
        });
        ws.on('error', () => {});
        " 2>/dev/null || true
    fi
fi

exit 0
