#!/usr/bin/env bash
# Claude wrapper script - Captures terminal context before launching Claude
# This allows Claude hook events to be traced back to specific terminals

# Configuration
WORKSTREAM_REDIS_HOST="${WORKSTREAM_REDIS_HOST:-localhost}"
WORKSTREAM_REDIS_PORT="${WORKSTREAM_REDIS_PORT:-6379}"

# Detect VSCode PID from process tree
_claude_wrapper_detect_vscode_pid() {
  # Check if we're in VSCode terminal
  [[ "$TERM_PROGRAM" != "vscode" ]] && return 1

  # Walk up process tree to find VSCode extension host
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
    echo "$vscode_pid"
    return 0
  fi

  return 1
}

# Get terminal session identifier
_claude_wrapper_get_terminal_id() {
  # Try to get VSCode PID from environment or detect it
  local vscode_pid="${VSCODE_PID:-}"

  if [[ -z "$vscode_pid" ]] && [[ "$TERM_PROGRAM" == "vscode" ]]; then
    vscode_pid=$(_claude_wrapper_detect_vscode_pid)
  fi

  # Use PPID (parent shell) not $$ (this wrapper process)
  local shell_pid=$PPID

  if [[ -n "$vscode_pid" ]]; then
    # VSCode integrated terminal - use VSCode PID + shell PID
    echo "vscode-${vscode_pid}-${shell_pid}"
  else
    # Regular terminal - just use shell PID
    echo "shell-${shell_pid}"
  fi
}

# Find the real Claude binary (not this wrapper)
find_real_claude() {
  # Get the directory where this script is located
  local wrapper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local wrapper_path="$wrapper_dir/$(basename "${BASH_SOURCE[0]}")"

  # Find all claude binaries in PATH
  local IFS=:
  for dir in $PATH; do
    local candidate="$dir/claude"
    # Skip if it doesn't exist or isn't executable
    [[ ! -x "$candidate" ]] && continue

    # Skip if it's this wrapper script
    [[ "$candidate" -ef "$wrapper_path" ]] && continue

    # Skip if it's a symlink to this wrapper
    if [[ -L "$candidate" ]]; then
      local target=$(readlink "$candidate")
      [[ "$target" -ef "$wrapper_path" ]] && continue
    fi

    # Found a real Claude binary
    echo "$candidate"
    return 0
  done

  # Fallback: try common locations
  for candidate in "/usr/local/bin/claude" "$HOME/.local/bin/claude" "$HOME/bin/claude"; do
    [[ -x "$candidate" ]] && [[ ! "$candidate" -ef "$wrapper_path" ]] && echo "$candidate" && return 0
  done

  return 1
}

# Main execution
main() {
  # Find the real Claude binary
  real_claude=$(find_real_claude)

  if [[ -z "$real_claude" ]]; then
    echo "Error: Could not find real Claude binary" >&2
    echo "Please ensure Claude is installed in your PATH" >&2
    exit 1
  fi

  # Capture terminal context
  terminal_id=$(_claude_wrapper_get_terminal_id)
  terminal_pid=$PPID  # Use parent PID (the shell), not wrapper's PID
  vscode_pid="${VSCODE_PID:-}"

  # We need to launch Claude and capture its PID
  # Since we're using exec, we'll spawn Claude in background first to get its PID
  # Then store the mapping before it fully starts

  # Alternative approach: Store with our PID, then update when we know Claude's PID
  # But actually, when we exec, our PID becomes Claude's PID!
  # So we can store the mapping with our current PID

  # Build JSON payload for Redis
  local json=$(cat <<EOF
{
  "terminalId": "$terminal_id",
  "terminalPid": $terminal_pid,
  "vscodePid": ${vscode_pid:-null}
}
EOF
)

  # Store terminal context in Redis (1 hour TTL)
  # Key format: claude:terminal:{pid}
  # When we exec, this PID will become Claude's PID
  local redis_key="claude:terminal:$$"

  # Check if redis-cli is available
  if command -v redis-cli >/dev/null 2>&1; then
    echo "$json" | redis-cli -h "$WORKSTREAM_REDIS_HOST" -p "$WORKSTREAM_REDIS_PORT" -x SETEX "$redis_key" 3600 >/dev/null 2>&1
  else
    echo "Warning: redis-cli not found. Terminal tracking will not work." >&2
  fi

  # Execute the real Claude binary (replaces this process)
  exec "$real_claude" "$@"
}

# Run main function
main "$@"
