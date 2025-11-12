# Workstream Daemon

Optional background service that maintains a real-time index of VS Code instances with metadata. This makes the Raycast extension and CLI tool **instant** by pre-fetching all metadata.

## What It Does

The daemon runs in the background and:
- ⚡ Polls VS Code instances every 5 seconds
- 📊 Fetches git status, PR info, and Claude Code status
- 💾 Maintains a cache file at `~/.workstream-daemon/instances.json`
- 🔴 Uses Redis pub/sub for real-time updates
- 🚀 Makes the Raycast extension load **instantly** (< 10ms)

## Prerequisites

**Redis must be running locally:**

```bash
# macOS (Homebrew)
brew install redis
brew services start redis

# Or manually
redis-server
```

Verify Redis is running:
```bash
redis-cli ping  # Should return "PONG"
```

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

# Or check Redis
redis-cli keys "workstream:*"
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
# View file cache
cat ~/.workstream-daemon/instances.json | jq

# View Redis data
redis-cli keys "workstream:*"
redis-cli get workstream:timestamp
redis-cli smembers workstream:instances:list
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
- `INSTANCE_TTL`: Redis key expiration (default: 30 seconds)
- `CACHE_DIR`: Cache directory (default: ~/.workstream-daemon)

Redis configuration in `src/redis-client.ts`:
- `host`: Redis host (default: localhost)
- `port`: Redis port (default: 6379)

## Claude Code Integration

The daemon can receive real-time notifications from Claude Code via hooks:

### Setup

1. **Ensure redis-cli is available** (installed automatically with Redis):
   ```bash
   which redis-cli  # Should show path to redis-cli
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
         "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh"}]
       }],
       "PreToolUse": [{
         "matcher": "*",
         "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh"}]
       }],
       "Stop": [{
         "matcher": "*",
         "hooks": [{"type": "command", "command": "~/.claude/notify-daemon.sh"}]
       }]
     }
   }
   ```

   **Note**: The hook script automatically parses the event type from Claude's JSON context. It detects when AskUserQuestion or ExitPlanMode tools are used and sends `waiting_for_input` instead of `work_started`. No arguments needed!

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

The Raycast extension can read from Redis or the cache file for instant results:

```typescript
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });

async function loadFromRedis() {
  try {
    // Get instance paths
    const paths = await redis.smembers('workstream:instances:list');

    // Get each instance data
    const pipeline = redis.pipeline();
    for (const path of paths) {
      const key = `workstream:instance:${Buffer.from(path).toString('base64')}`;
      pipeline.get(key);
    }

    const results = await pipeline.exec();
    return results.map(([, data]) => JSON.parse(data as string));
  } catch {
    // Redis not available, fallback to file cache
    return null;
  }
}
```

### Redis Pub/Sub Client (Real-time Updates)

```typescript
import Redis from 'ioredis';

const subscriber = new Redis({ host: 'localhost', port: 6379 });

subscriber.subscribe('workstream:updates');

subscriber.on('message', async (channel, message) => {
  if (channel === 'workstream:updates') {
    const { type, count, timestamp } = JSON.parse(message);
    if (type === 'instances') {
      console.log(`Received update: ${count} instances at ${timestamp}`);
      // Load latest data from Redis
      const instances = await loadFromRedis();
    }
  }
});

// Trigger refresh
const publisher = new Redis({ host: 'localhost', port: 6379 });
await publisher.publish('workstream:refresh', JSON.stringify({ type: 'refresh' }));
```

## Performance Comparison

**Without Daemon:**
- First load: 2-3 seconds (fetches everything)
- Cached loads: ~500ms (reads from Raycast cache)

**With Daemon (Redis):**
- Every load: < 10ms (reads from Redis)
- Always up-to-date (refreshed every 5 seconds)
- Real-time updates via pub/sub

## Troubleshooting

### Daemon won't start

Check logs:
```bash
tail -f ~/Library/Logs/workstream-daemon-error.log
```

### Redis connection issues

Check if Redis is running:
```bash
redis-cli ping
```

Start Redis:
```bash
brew services start redis
```

### Cache not updating

Check if daemon is running:
```bash
launchctl list | grep workstream
```

Check Redis data:
```bash
redis-cli keys "workstream:*"
redis-cli ttl workstream:timestamp
```

Restart daemon:
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
└────────┬────────┘         └──────────────┘
         │
         │ Redis Pub/Sub + Storage
         ↓
┌─────────────────┐
│  Redis Server   │
│  (localhost)    │
└────────┬────────┘
         │
         ↓ reads + subscribes
┌─────────────────┐         ┌──────────────┐
│  Raycast Ext    │         │  CLI Tool    │
│  (live updates) │         │  (instant)   │
└─────────────────┘         └──────────────┘
```

## Redis Data Structure

```
Keys:
- workstream:instances:list         (SET)    → Set of instance paths
- workstream:instance:{base64path}  (STRING) → JSON instance data
- workstream:timestamp              (STRING) → Last update timestamp

Pub/Sub Channels:
- workstream:updates                → Instance list updates
- workstream:refresh                → Trigger refresh requests
- workstream:claude:{base64path}    → Claude status updates

TTL: All keys expire after 30 seconds if daemon stops
```

## Development

### Watch mode

```bash
pnpm run dev
```

### Testing locally

1. Start Redis: `redis-server`
2. Run daemon: `pnpm start`
3. Check Redis: `redis-cli keys "workstream:*"`
4. Monitor pub/sub: `redis-cli subscribe workstream:updates`

## License

MIT
