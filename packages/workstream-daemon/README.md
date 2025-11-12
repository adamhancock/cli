# Workstream Daemon

Optional background service that maintains a real-time index of VS Code instances with metadata. This makes the Raycast extension and CLI tool **instant** by pre-fetching all metadata.

## What It Does

The daemon runs in the background and:
- ⚡ Polls VS Code instances every 5 seconds
- 📊 Fetches git status, PR info, and Claude Code status
- 💾 Maintains a cache file at `~/.workstream-daemon/instances.json`
- 🔌 Provides a WebSocket server on `ws://localhost:58234` for real-time updates
- 🚀 Makes the Raycast extension load **instantly** (< 10ms)

## Installation

### Option 1: Install via npm/pnpm (Recommended)

```bash
pnpm add -g @adamhancock/workstream-daemon
```

Then you can use the `workstream` command:

```bash
workstream start      # Start the daemon
workstream status     # Check status
workstream stop       # Stop the daemon
workstream install    # Install as macOS service
```

### Option 2: Install from source

```bash
cd packages/workstream-daemon
pnpm install
pnpm link --global
```

### Install as macOS LaunchAgent (auto-start on login)

```bash
workstream install
```

This will:
- Create a LaunchAgent plist file
- Configure it to run automatically on login
- Start the daemon immediately
- Set up logging to `~/Library/Logs/workstream-daemon.log`

## Usage

### CLI Commands

```bash
workstream start         # Start daemon in background
workstream stop          # Stop running daemon
workstream console       # Run daemon in foreground with live output (debugging)
workstream status        # Check if daemon is running
workstream logs          # Watch all logs in real-time
workstream logs stdout   # Watch only stdout logs
workstream logs stderr   # Watch only error logs
workstream install       # Install as macOS service (auto-start)
workstream uninstall     # Remove macOS service
workstream help          # Show help message
```

### Running Manually (for development)

The easiest way to run the daemon with live output:

```bash
workstream console
```

Or run directly with pnpm (same behavior):

```bash
pnpm start
```

### Check if Running

```bash
# Using CLI (recommended)
workstream status

# Or check process manually
ps aux | grep workstream-daemon

# Or check WebSocket
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" -H "Sec-WebSocket-Version: 13" \
  http://localhost:58234
```

### View Logs

```bash
# Using CLI (recommended) - watches both stdout and stderr
workstream logs

# Watch only stdout
workstream logs stdout

# Watch only errors
workstream logs stderr

# Or manually with tail
tail -f ~/Library/Logs/workstream-daemon.log
tail -f ~/Library/Logs/workstream-daemon-error.log
```

### View Cache

```bash
# Pretty print the cache
cat ~/.workstream-daemon/instances.json | jq
```

## Uninstallation

```bash
workstream uninstall
```

This will:
- Stop the daemon
- Remove the LaunchAgent
- Keep cache files (delete manually if needed)

To completely remove:
```bash
workstream uninstall
rm -rf ~/.workstream-daemon
pnpm remove -g @adamhancock/workstream-daemon
```

## Configuration

Edit these constants in `src/index.ts`:

- `POLL_INTERVAL`: How often to poll (default: 5000ms)
- `WS_PORT`: WebSocket server port (default: 58234)
- `CACHE_DIR`: Cache directory (default: ~/.workstream-daemon)

## Claude Code Integration

The daemon can receive real-time notifications from Claude Code via hooks:

### Setup

1. **Install websocat** (required for WebSocket communication):
   ```bash
   brew install websocat
   ```

2. **Copy the hook script** to `~/.claude/`:
   ```bash
   cp notify-daemon.sh ~/.claude/notify-daemon.sh
   chmod +x ~/.claude/notify-daemon.sh
   ```

3. **Configure Claude hooks** in `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "UserPromptSubmit": [{
         "matcher": "*",
         "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh work_started"}]
       }],
       "PreToolUse": [
         {
           "matcher": "AskUserQuestion|ExitPlanMode",
           "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh waiting_for_input"}]
         },
         {
           "matcher": "*",
           "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh work_started"}]
         }
       ],
       "Stop": [{
         "matcher": "*",
         "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh work_stopped"}]
       }]
     }
   }
   ```

### What It Does

The daemon tracks Claude's working state using hooks instead of CPU monitoring for accurate, real-time status:

- 🚀 **Work Started**: When you submit a prompt or Claude uses any tool
  - Updates status to "Working" (purple in Raycast)
  - Triggered by: User message submission or any tool use

- 🤔 **Waiting for Input**: When Claude shows an interactive prompt
  - Triggered by: AskUserQuestion tool, ExitPlanMode (plan approval), or any explicit question
  - Updates status to "Waiting" (orange in Raycast)
  - Sends macOS notification: "🤔 Claude needs your attention in [project]"

- ✅ **Work Stopped**: When Claude finishes a task (Stop hook)
  - Clears working and waiting status (gray "Idle" in Raycast)
  - Sends macOS notification: "✅ Claude finished working in [project]"

This hook-based approach is more reliable than CPU monitoring since it directly tracks Claude's actual state changes.

### Testing

Test the hook script manually:
```bash
# Test work started
echo '{"session_id":"test"}' | CLAUDE_PROJECT_DIR="$(pwd)" ~/.claude/notify-daemon.sh work_started

# Test waiting for input
echo '{"session_id":"test"}' | CLAUDE_PROJECT_DIR="$(pwd)" ~/.claude/notify-daemon.sh waiting_for_input

# Test work stopped
echo '{"session_id":"test"}' | CLAUDE_PROJECT_DIR="$(pwd)" ~/.claude/notify-daemon.sh work_stopped
```

You should see status updates in Raycast and notifications for waiting/finished events.

## How Clients Use It

### Raycast Extension

The Raycast extension can read from the cache file for instant results:

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_FILE = join(homedir(), '.workstream-daemon', 'instances.json');

async function loadFromDaemon() {
  try {
    const cache = await readFile(CACHE_FILE, 'utf-8');
    const { instances } = JSON.parse(cache);
    return instances;
  } catch {
    // Daemon not running, fallback to direct fetch
    return null;
  }
}
```

### WebSocket Client (Real-time Updates)

```typescript
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:58234');

ws.on('message', (data) => {
  const { type, data: instances } = JSON.parse(data.toString());
  if (type === 'instances') {
    console.log('Received update:', instances);
  }
});

// Request refresh
ws.send(JSON.stringify({ type: 'refresh' }));
```

## Performance Comparison

**Without Daemon:**
- First load: 2-3 seconds (fetches everything)
- Cached loads: ~500ms (reads from Raycast cache)

**With Daemon:**
- Every load: < 10ms (reads pre-computed cache)
- Always up-to-date (refreshed every 5 seconds)

## Troubleshooting

### Daemon won't start

Check logs:
```bash
tail -f ~/Library/Logs/workstream-daemon-error.log
```

### Port already in use

Change `WS_PORT` in `src/index.ts` and rebuild.

### Cache not updating

Check if daemon is running:
```bash
launchctl list | grep workstream
```

Restart it:
```bash
launchctl stop com.workstream.daemon
launchctl start com.workstream.daemon
```

## Architecture

```
┌─────────────────┐
│  VS Code        │
│  Instances      │
└────────┬────────┘
         │
         ↓ (lsof every 5s)
┌─────────────────┐         ┌──────────────┐
│  Workstream     │ ──────→ │  Cache File  │
│  Daemon         │  writes │  .json       │
└────────┬────────┘         └──────┬───────┘
         │                          │
         │ WebSocket                │ reads
         ↓                          ↓
┌─────────────────┐         ┌──────────────┐
│  Raycast Ext    │         │  CLI Tool    │
│  (live updates) │         │  (instant)   │
└─────────────────┘         └──────────────┘
```

## Development

### Watch mode

```bash
pnpm run dev
```

### Testing locally

1. Build: `pnpm run build`
2. Run: `pnpm start`
3. In another terminal: `cat ~/.workstream-daemon/instances.json`

## License

MIT
