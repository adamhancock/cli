# Workstream VSCode Extension

Real-time workspace tracking for the Workstream system. This extension sends instant updates about your VSCode activity to Redis, providing zero-latency event tracking that complements the polling-based daemon.

## Features

- **Instant Updates**: 0ms latency for file saves, git operations, and terminal events
- **Rich Terminal Tracking**: Monitor terminal count, names, and purposes (dev servers, testing, build)
- **File Activity Monitoring**: Track saves/min, active files, and dirty file counts
- **Git Event Detection**: Instant notifications of branch switches and commits
- **Debug Session Tracking**: Monitor active debug sessions and types
- **Window State**: Track when VSCode windows are focused/blurred
- **Seamless Integration**: Works alongside existing polling as a complementary real-time layer

## Installation

### From Source

1. Build the extension:
   ```bash
   pnpm build:vscode-extension
   ```

2. Package the extension:
   ```bash
   pnpm package:vscode-extension
   ```

3. Install the `.vsix` file:
   ```bash
   code --install-extension packages/workstream-vscode-extension/workstream-vscode-extension-0.1.0.vsix
   ```

### Development

To test the extension in the Extension Development Host:

1. Open the workstream-vscode-extension folder in VSCode
2. Press F5 to launch the Extension Development Host
3. Open a workspace in the new window
4. Check the status bar for "Workstream" connection indicator

## Configuration

The extension can be configured through VSCode settings:

```json
{
  "workstream.enabled": true,
  "workstream.redis.host": "localhost",
  "workstream.redis.port": 6379,
  "workstream.heartbeatInterval": 10000
}
```

### Settings

- `workstream.enabled` - Enable/disable the extension (default: `true`)
- `workstream.redis.host` - Redis server host (default: `localhost`)
- `workstream.redis.port` - Redis server port (default: `6379`)
- `workstream.heartbeatInterval` - Heartbeat interval in milliseconds (default: `10000`)

## How It Works

### Architecture

The extension uses a hybrid push + pull approach:

1. **Push (Events)**: Instant pub/sub notifications for important changes
   - File saved
   - Git branch changed
   - Terminal opened/closed
   - Debug session started/stopped

2. **Pull (State)**: Periodic state snapshots every 10 seconds
   - Terminal count and details
   - File activity metrics
   - Debug session info
   - Window focus state

### Redis Integration

#### Pub/Sub Channels

- `workstream:vscode:heartbeat` - Heartbeat with metadata
- `workstream:vscode:workspace` - Window/workspace events
- `workstream:vscode:file` - File operation events
- `workstream:vscode:git` - Git operation events
- `workstream:vscode:terminal` - Terminal/debug events

#### State Keys

```
workstream:vscode:state:{base64-encoded-path}
```

State keys have a 30-second TTL and contain:
- Workspace path and VSCode version
- Terminal counts, names, and purposes
- File activity (saves/5min, active file, dirty count)
- Git branch and recent operations
- Debug session info
- Window focus state

### Terminal Purpose Detection

The extension automatically categorizes terminals based on their names:

- **dev-server**: Names containing "dev", "serve", "server"
- **testing**: Names containing "test", "jest", "vitest", "pytest"
- **build**: Names containing "build", "watch", "compile"
- **general**: Everything else

## Daemon Integration

The workstream daemon automatically detects when the extension is active by checking for fresh state keys (updated within last 30 seconds). When the extension is active:

1. Extension data is preferred for real-time events
2. Polling frequency can be reduced (from 5s to 30-60s)
3. Instance metadata includes `extensionActive: true`
4. Rich terminal and file activity data is available

## Status Bar

The extension displays a status bar item showing connection state:

- ✅ **Workstream** - Connected to Redis
- 🔄 **Workstream** - Reconnecting...
- ❌ **Workstream** - Failed to connect
- ⊘ **Workstream** - Extension disabled

Click the status bar item for more details.

## Troubleshooting

### Extension Not Connecting

1. Check Redis is running: `redis-cli ping`
2. Verify settings: Check `workstream.redis.host` and `workstream.redis.port`
3. Check console: View > Developer Tools > Console (filter by "Workstream")

### Events Not Appearing in Raycast

1. Ensure workstream daemon is running
2. Check daemon logs for extension state detection
3. Verify Redis key exists: `redis-cli GET workstream:vscode:state:{base64-path}`
4. Check key TTL: `redis-cli TTL workstream:vscode:state:{base64-path}` (should be ~30s)

### Git Events Not Firing

1. Ensure Git extension is installed and active
2. Open workspace must be a git repository
3. Git operations must be performed within VSCode (not external terminal)

## Development

### Project Structure

```
src/
├── extension.ts           # Entry point
├── RedisPublisher.ts      # Redis connection & publishing
├── StateManager.ts        # State aggregation & heartbeat
├── types.ts              # TypeScript interfaces
├── config.ts             # Extension settings
└── trackers/
    ├── WorkspaceTracker.ts   # Window/workspace events
    ├── FileTracker.ts        # File operations
    ├── GitTracker.ts         # Git operations
    └── TerminalTracker.ts    # Terminal & debug
```

### Building

```bash
# Build once
pnpm build:vscode-extension

# Watch mode
pnpm dev:vscode-extension

# Package for distribution
pnpm package:vscode-extension
```

### Testing

1. Press F5 in VSCode (Extension Development Host)
2. Monitor Redis events: `redis-cli MONITOR | grep workstream:vscode`
3. Check state keys: `redis-cli --scan --pattern "workstream:vscode:state:*"`
4. View extension logs: Developer Tools > Console

## Architecture Diagram

```
┌─────────────────────────────┐
│   VSCode Extension          │
│   - Tracks events in real-  │
│     time via VSCode API     │
│   - Publishes to Redis      │
│   - Heartbeat every 10s     │
└─────────┬───────────────────┘
          │
          │ Redis Pub/Sub + State Keys
          ↓
┌─────────────────────────────┐
│   Redis Server              │
│   - Stores state (30s TTL)  │
│   - Pub/sub for events      │
└─────────┬───────────────────┘
          │
          │ Daemon reads state + events
          ↓
┌─────────────────────────────┐
│   Workstream Daemon         │
│   - Merges extension data   │
│   - Reduces polling when    │
│     extension is active     │
│   - Enriches with PR info   │
└─────────┬───────────────────┘
          │
          │ Cache + Pub/Sub
          ↓
┌─────────────────────────────┐
│   Raycast Extension / CLI   │
│   - Real-time updates       │
│   - Rich metadata display   │
└─────────────────────────────┘
```

## Event Schema

### Workspace Event
```json
{
  "type": "window-state-changed",
  "workspacePath": "/path/to/workspace",
  "timestamp": 1234567890,
  "data": { "focused": true }
}
```

### File Event
```json
{
  "type": "file-saved",
  "workspacePath": "/path/to/workspace",
  "timestamp": 1234567890,
  "data": {
    "fileName": "/path/to/file.ts",
    "languageId": "typescript"
  }
}
```

### Git Event
```json
{
  "type": "branch-checkout",
  "workspacePath": "/path/to/workspace",
  "timestamp": 1234567890,
  "data": {
    "from": "main",
    "to": "feature-branch"
  }
}
```

### Terminal Event
```json
{
  "type": "terminal-opened",
  "workspacePath": "/path/to/workspace",
  "timestamp": 1234567890,
  "data": {
    "name": "npm run dev",
    "pid": 12345,
    "purpose": "dev-server"
  }
}
```

## License

ISC
