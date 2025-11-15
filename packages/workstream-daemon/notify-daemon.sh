#!/bin/bash

# Claude hook script to notify workstream daemon via Redis
# Automatically determines event type from hook context

REDIS_HOST="localhost"
REDIS_PORT="6379"
REDIS_CHANNEL="workstream:claude"

# Read JSON context from stdin (provided by Claude hooks)
CONTEXT=$(cat)

# Extract hook event name and tool name from context
HOOK_EVENT=$(echo "$CONTEXT" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
TOOL_NAME=$(echo "$CONTEXT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
NOTIFICATION_TYPE=$(echo "$CONTEXT" | grep -o '"notification_type":"[^"]*"' | cut -d'"' -f4)

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
  Notification)
    # Check notification type - permission prompts and idle prompts mean Claude is waiting
    if [ "$NOTIFICATION_TYPE" = "permission_prompt" ] || [ "$NOTIFICATION_TYPE" = "idle_prompt" ]; then
      EVENT_TYPE="waiting_for_input"
    else
      # Other notifications don't change the working state
      EVENT_TYPE="${1:-work_started}"
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

# Get Claude's PID (parent process of this hook script)
CLAUDE_PID="$PPID"

# Look up terminal context from Redis if available
TERMINAL_ID=""
TERMINAL_PID=""
VSCODE_PID=""

if command -v redis-cli &> /dev/null; then
    # Try to fetch terminal context for this Claude instance
    REDIS_KEY="claude:terminal:$CLAUDE_PID"
    TERMINAL_CONTEXT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" GET "$REDIS_KEY" 2>/dev/null || echo "")

    if [ -n "$TERMINAL_CONTEXT" ]; then
        # Extract terminal info from JSON
        TERMINAL_ID=$(echo "$TERMINAL_CONTEXT" | grep -o '"terminalId":"[^"]*"' | cut -d'"' -f4)
        TERMINAL_PID=$(echo "$TERMINAL_CONTEXT" | grep -o '"terminalPid":[0-9]*' | grep -o '[0-9]*')
        VSCODE_PID=$(echo "$TERMINAL_CONTEXT" | grep -o '"vscodePid":[0-9]*' | grep -o '[0-9]*')
    fi
fi

# Debug logging (enabled for troubleshooting)
DEBUG_LOG="$HOME/.claude/workstream-hook-debug.log"
mkdir -p "$HOME/.claude"

# Log basic info
if [ -n "$NOTIFICATION_TYPE" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $HOOK_EVENT -> $EVENT_TYPE (notification: $NOTIFICATION_TYPE) in $PROJECT_DIR [terminal: $TERMINAL_ID]" >> "$DEBUG_LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $HOOK_EVENT -> $EVENT_TYPE ($TOOL_NAME) in $PROJECT_DIR [terminal: $TERMINAL_ID]" >> "$DEBUG_LOG"
fi

# Log full context for investigation
echo "  Full context: $CONTEXT" >> "$DEBUG_LOG"
echo "  ---" >> "$DEBUG_LOG"

# Send event to daemon via Redis pub/sub
# Using redis-cli to publish to the refresh channel
if command -v redis-cli &> /dev/null; then
    # Build message with terminal context (if available)
    if [ -n "$TERMINAL_ID" ]; then
        # Include terminal context in message
        MESSAGE="{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\",\"terminalId\":\"$TERMINAL_ID\",\"terminalPid\":$TERMINAL_PID"

        # Add vscodePid if present
        if [ -n "$VSCODE_PID" ]; then
            MESSAGE="${MESSAGE},\"vscodePid\":$VSCODE_PID}"
        else
            MESSAGE="${MESSAGE}}"
        fi
    else
        # No terminal context available, send basic message
        MESSAGE="{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\"}"
    fi

    # Publish to Redis channel
    echo "$MESSAGE" | redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -x PUBLISH "$REDIS_CHANNEL" >/dev/null 2>&1 || true
else
    # If redis-cli is not available, log a warning
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: redis-cli not found, cannot notify daemon" >> /tmp/claude-hook-debug.log
fi

exit 0
