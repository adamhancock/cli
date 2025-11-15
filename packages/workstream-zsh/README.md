# Workstream zsh Plugin

zsh plugin that reports terminal activity to Redis for integration with the Workstream system.

## What It Does

- Reports current command being executed in terminal
- Tracks working directory changes
- Detects VSCode integrated terminals automatically
- Publishes terminal state to Redis for Raycast terminal switcher

## Installation

### Via Oh My Zsh

1. Clone to custom plugins directory:
   ```bash
   git clone https://github.com/your-repo/workstream-zsh ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/workstream
   ```

2. Add to plugins in `~/.zshrc`:
   ```bash
   plugins=(... workstream)
   ```

3. Reload shell:
   ```bash
   source ~/.zshrc
   ```

### Manual Installation

1. Source the plugin in your `~/.zshrc`:
   ```bash
   source /path/to/workstream.plugin.zsh
   ```

2. Reload shell:
   ```bash
   source ~/.zshrc
   ```

### Local Development (from this monorepo)

Add to your `~/.zshrc`:
```bash
source ~/Code/cli/packages/workstream-zsh/workstream.plugin.zsh
```

## Configuration

Set these environment variables in your `~/.zshrc` before sourcing the plugin:

```bash
# Redis connection (defaults shown)
export WORKSTREAM_REDIS_HOST="localhost"
export WORKSTREAM_REDIS_PORT="6379"

# Enable/disable tracking
export WORKSTREAM_ENABLED="1"  # Set to 0 to disable

# Then source the plugin
source ~/Code/cli/packages/workstream-zsh/workstream.plugin.zsh
```

## How It Works

### Hooks

The plugin uses zsh's built-in hooks:

- **preexec** - Runs before each command executes
- **precmd** - Runs before each prompt (after command completes)

### VSCode Detection

When running in VSCode's integrated terminal, zsh automatically sets:
- `$VSCODE_PID` - The VSCode process ID
- `$VSCODE_WORKSPACE_FOLDER` - The workspace path

The plugin uses these to associate terminals with VSCode instances.

### Data Published to Redis

#### Redis Key (60s TTL)
```
workstream:terminal:{terminalId}
```

Contains JSON:
```json
{
  "terminalId": "vscode-12345-67890",
  "pid": 67890,
  "vscodePid": 12345,
  "workspace": "/Users/you/project",
  "cwd": "/Users/you/project/src",
  "currentCommand": "npm run dev",
  "shellType": "/bin/zsh",
  "timestamp": 1234567890
}
```

#### Pub/Sub Channel
```
workstream:terminal:events
```

Publishes the same JSON to notify subscribers of terminal activity.

### Terminal ID Format

- **VSCode terminals**: `vscode-{VSCODE_PID}-{SHELL_PID}`
- **Regular terminals**: `shell-{SHELL_PID}`

## Requirements

- zsh shell
- `redis-cli` command available in PATH
- Redis server running (default: localhost:6379)

## Troubleshooting

### Plugin not working

1. Check if redis-cli is installed:
   ```bash
   which redis-cli
   ```

2. Test Redis connection:
   ```bash
   redis-cli -h localhost -p 6379 ping
   ```

3. Check if plugin is loaded:
   ```bash
   typeset -f _workstream_preexec
   ```

### VSCode terminal not detected

VSCode sets `$VSCODE_PID` automatically. To verify:
```bash
echo $VSCODE_PID
```

If empty, you're not in a VSCode integrated terminal.

### Disable tracking temporarily

```bash
export WORKSTREAM_ENABLED=0
```

Re-enable:
```bash
export WORKSTREAM_ENABLED=1
```

## Performance

- Hooks run in background using `&` to avoid blocking the shell
- Redis operations timeout after 1 second
- No performance impact on shell responsiveness
- State keys have 60-second TTL to prevent Redis bloat

## Privacy

The plugin reports:
- Commands you execute (visible in shell)
- Working directories
- Process IDs

It does **not** report:
- Command output
- Environment variables (except those listed in config)
- File contents

To disable, set `WORKSTREAM_ENABLED=0` or remove the plugin.

## Integration with Workstream

This plugin works with:
- **Workstream VSCode Extension** - Associates terminals with VSCode workspaces
- **Workstream Daemon** - Merges terminal data with instance metadata
- **Raycast Extension** - Provides terminal switcher command

## License

ISC
