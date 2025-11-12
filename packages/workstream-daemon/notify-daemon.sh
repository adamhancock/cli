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

# Send event to daemon via Redis pub/sub
# Using redis-cli to publish to the refresh channel
if command -v redis-cli &> /dev/null; then
    # Publish to Redis channel
    MESSAGE="{\"type\":\"$EVENT_TYPE\",\"path\":\"$PROJECT_DIR\"}"
    echo "$MESSAGE" | redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -x PUBLISH "$REDIS_CHANNEL" >/dev/null 2>&1 || true
else
    # If redis-cli is not available, log a warning
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: redis-cli not found, cannot notify daemon" >> /tmp/claude-hook-debug.log
fi

exit 0
