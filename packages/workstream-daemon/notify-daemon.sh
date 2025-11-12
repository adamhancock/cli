#!/bin/bash

# Claude hook script to notify workstream daemon
# Usage: notify-daemon.sh <event_type>

EVENT_TYPE="$1"
DAEMON_WS="ws://localhost:58234"

# Read JSON context from stdin (provided by Claude hooks)
CONTEXT=$(cat)

# Extract project directory from environment variable (set by Claude)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

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
