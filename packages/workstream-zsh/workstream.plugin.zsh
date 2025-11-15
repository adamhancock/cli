#!/usr/bin/env zsh
# Workstream zsh plugin - Reports terminal activity to Redis

# Configuration
WORKSTREAM_REDIS_HOST="${WORKSTREAM_REDIS_HOST:-localhost}"
WORKSTREAM_REDIS_PORT="${WORKSTREAM_REDIS_PORT:-6379}"
WORKSTREAM_ENABLED="${WORKSTREAM_ENABLED:-1}"

# Detect VSCode PID from process tree (cache for performance)
_workstream_cached_vscode_pid=""
_workstream_detect_vscode_pid() {
  # Return cached value if available
  [[ -n "$_workstream_cached_vscode_pid" ]] && echo "$_workstream_cached_vscode_pid" && return 0

  # Check if we're in VSCode terminal
  [[ "$TERM_PROGRAM" != "vscode" ]] && return 1

  # Walk up process tree to find VSCode extension host
  # VSCode extension host is typically "Code Helper" or "node" process
  local pid=$$
  local vscode_pid=""

  # Look for extension host (node process under VSCode)
  while [[ $pid -ne 1 ]]; do
    local cmd=$(ps -p $pid -o comm= 2>/dev/null)

    # Found the extension host - get its PID
    if [[ "$cmd" == */node ]] || [[ "$cmd" == *"Code Helper"* ]]; then
      vscode_pid=$pid
      break
    fi

    pid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
    [[ -z "$pid" ]] && break
  done

  if [[ -n "$vscode_pid" ]]; then
    _workstream_cached_vscode_pid=$vscode_pid
    echo "$vscode_pid"
    return 0
  fi

  return 1
}

# Get terminal session identifier (use VSCODE_PID if in VSCode terminal)
_workstream_get_terminal_id() {
  # Try to get VSCode PID from environment or detect it
  local vscode_pid="${VSCODE_PID:-}"

  if [[ -z "$vscode_pid" ]] && [[ "$TERM_PROGRAM" == "vscode" ]]; then
    vscode_pid=$(_workstream_detect_vscode_pid)
  fi

  if [[ -n "$vscode_pid" ]]; then
    # VSCode integrated terminal - use VSCode PID + our shell PID
    echo "vscode-${vscode_pid}-$$"
  else
    # Regular terminal - just use shell PID
    echo "shell-$$"
  fi
}

# Get workspace path (prioritize VSCode workspace)
_workstream_get_workspace() {
  if [[ -n "$VSCODE_WORKSPACE_FOLDER" ]]; then
    echo "$VSCODE_WORKSPACE_FOLDER"
  else
    # Find git root if we're in a repo
    local git_root
    git_root=$(git rev-parse --show-toplevel 2>/dev/null)
    if [[ -n "$git_root" ]]; then
      echo "$git_root"
    else
      echo "$PWD"
    fi
  fi
}

# Report terminal state to Redis
_workstream_report() {
  # Skip if disabled
  [[ "$WORKSTREAM_ENABLED" != "1" ]] && return 0

  local terminal_id=$(_workstream_get_terminal_id)
  local workspace=$(_workstream_get_workspace)
  local timestamp=$(date +%s)

  # Build JSON payload
  local json=$(cat <<EOF
{
  "terminalId": "$terminal_id",
  "pid": $$,
  "vscodePid": ${VSCODE_PID:-null},
  "workspace": "$workspace",
  "cwd": "$PWD",
  "currentCommand": "$1",
  "shellType": "$SHELL",
  "timestamp": $timestamp
}
EOF
)

  # Send to Redis using redis-cli (non-blocking)
  # Using &| to disown jobs immediately (prevents job completion messages)
  (
    # Set terminal state key (60 second TTL)
    local key="workstream:terminal:${terminal_id}"
    echo "$json" | redis-cli -h "$WORKSTREAM_REDIS_HOST" -p "$WORKSTREAM_REDIS_PORT" -x SETEX "$key" 60 >/dev/null 2>&1 &|

    # Publish event
    redis-cli -h "$WORKSTREAM_REDIS_HOST" -p "$WORKSTREAM_REDIS_PORT" PUBLISH "workstream:terminal:events" "$json" >/dev/null 2>&1 &|
  ) &|
}

# Hook: Before command execution
_workstream_preexec() {
  _workstream_report "$1"
}

# Hook: After command completion (report idle state)
_workstream_precmd() {
  _workstream_report ""
}

# Register hooks if redis-cli is available
if command -v redis-cli >/dev/null 2>&1; then
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _workstream_preexec
  add-zsh-hook precmd _workstream_precmd

  # Initial report when shell starts
  _workstream_report ""
else
  echo "⚠️  workstream: redis-cli not found. Terminal tracking disabled."
fi
