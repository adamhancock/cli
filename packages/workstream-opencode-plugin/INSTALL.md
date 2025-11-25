# Installation Guide - Workstream OpenCode Plugin

## Prerequisites

1. **Redis** must be running
   ```bash
   # Check if Redis is running
   redis-cli ping
   # Should return: PONG
   
   # If not running, start Redis
   brew services start redis
   # or
   redis-server
   ```

2. **Workstream Daemon** must be running
   ```bash
   cd packages/workstream-daemon
   npm start
   ```

3. **OpenCode** must be installed
   ```bash
   # Check if OpenCode is installed
   which opencode
   
   # If not installed, follow instructions at:
   # https://opencode.ai
   ```

## Installation Steps

### Step 1: Build the Plugin

```bash
cd packages/workstream-opencode-plugin
npm install
npm run build
```

Verify the build succeeded:
```bash
ls dist/
# Should show compiled .js and .d.ts files
```

### Step 2: Link the Plugin

Choose one of the following installation methods:

#### Option A: Global Installation (Recommended)

Install globally for all your projects:

```bash
# Create OpenCode plugin directory
mkdir -p ~/.config/opencode/plugin

# Symlink the plugin
ln -sf $(pwd)/.opencode/plugin/workstream.ts ~/.config/opencode/plugin/workstream.ts

# Verify the symlink
ls -la ~/.config/opencode/plugin/
```

#### Option B: Project-Specific Installation

Install for a specific project only:

```bash
# Navigate to your project
cd /path/to/your/project

# Create plugin directory
mkdir -p .opencode/plugin

# Symlink the plugin (replace with your actual path to the workstream-opencode-plugin)
ln -sf /path/to/cli/packages/workstream-opencode-plugin/.opencode/plugin/workstream.ts .opencode/plugin/workstream.ts

# Verify the symlink
ls -la .opencode/plugin/
```

### Step 3: Configure the Plugin (Optional)

Create a configuration file in your project:

```bash
# Navigate to your project
cd /path/to/your/project

# Create config directory
mkdir -p .opencode

# Copy example configuration (replace with your actual path to the workstream-opencode-plugin)
cp /path/to/cli/packages/workstream-opencode-plugin/examples/workstream-config.json .opencode/workstream-config.json

# Edit configuration
vim .opencode/workstream-config.json
```

Configuration options:
```json
{
  "redis": {
    "host": "localhost",
    "port": 6379
  },
  "features": {
    "eventTracking": true,        // Track all OpenCode events
    "customTools": true,          // Enable workstream tools
    "contextInjection": true,     // Auto-inject workspace context
    "safetyGuards": true,         // Enable safety checks
    "analytics": true,            // Track metrics
    "notifications": true,        // Send notifications
    "biDirectionalControl": true  // Allow remote control
  },
  "analytics": {
    "costThreshold": 5.0,         // Alert at $5 USD
    "timeThreshold": 30,          // Alert after 30 minutes
    "errorThreshold": 10          // Alert after 10 errors
  },
  "safety": {
    "protectedBranches": ["main", "master", "production"],
    "requireCleanBranch": false,
    "confirmDestructiveCommands": ["rm -rf", "drop table"],
    "maxConcurrentSessions": 3
  },
  "notifications": {
    "onSessionIdle": true,
    "onError": true,
    "onCostThreshold": true,
    "onPRCheckComplete": true
  }
}
```

## Verification

### 1. Check Plugin is Loaded

Start OpenCode in a project:

```bash
cd /path/to/your/project
opencode
```

Look for initialization messages in the console:
```
[Workstream] Plugin initializing...
[Workstream] Connected to Redis
[Workstream] Plugin initialized for: /path/to/your/project
```

### 2. Verify Redis Connection

In another terminal, monitor Redis events:

```bash
# Subscribe to OpenCode events
redis-cli SUBSCRIBE workstream:opencode

# You should see events when OpenCode is active
```

### 3. Test Custom Tools

In OpenCode, try using a custom tool:

```
Can you check the workstream status?
```

OpenCode should use the `getWorkstreamStatus()` tool and return information about:
- Git branch and status
- PR checks (if applicable)
- Caddy development URL (if configured)
- Spotlight errors (if configured)
- VSCode extension status

### 4. Check Event Store

Verify events are being stored:

```bash
# Check for OpenCode session keys in Redis
redis-cli KEYS "workstream:opencode:session:*"

# View a session
redis-cli GET "workstream:opencode:session:{sessionId}"
```

## Troubleshooting

### Plugin Not Loading

1. **Check symlink exists:**
   ```bash
   ls -la ~/.config/opencode/plugin/workstream.ts
   # or
   ls -la .opencode/plugin/workstream.ts
   ```

2. **Check symlink target:**
   ```bash
   readlink ~/.config/opencode/plugin/workstream.ts
   # Should point to: .../workstream-opencode-plugin/.opencode/plugin/workstream.ts
   ```

3. **Verify build output:**
   ```bash
   ls packages/workstream-opencode-plugin/dist/index.js
   # File should exist
   ```

4. **Check OpenCode verbose logs:**
   ```bash
   opencode --verbose
   ```

### Redis Connection Errors

1. **Verify Redis is running:**
   ```bash
   redis-cli ping
   ```

2. **Check Redis port:**
   ```bash
   redis-cli INFO server | grep tcp_port
   # Default: 6379
   ```

3. **Test Redis connection:**
   ```bash
   redis-cli
   > SET test "hello"
   > GET test
   > DEL test
   ```

### Workstream Daemon Not Tracking

1. **Check daemon is running:**
   ```bash
   ps aux | grep workstream-daemon
   ```

2. **View daemon logs:**
   ```bash
   cd packages/workstream-daemon
   npm start
   # Look for instance detection logs
   ```

3. **Check instance data in Redis:**
   ```bash
   redis-cli KEYS "workstream:instance:*"
   redis-cli GET "workstream:instance:{base64_path}"
   ```

### Tools Not Working

1. **Ensure daemon has detected your workspace:**
   ```bash
   # The daemon uses lsof to detect VSCode instances
   # Ensure your project is open in VSCode
   ```

2. **Check instance data:**
   ```bash
   # Get your workspace path in base64
   echo -n "/path/to/workspace" | base64
   
   # Check Redis
   redis-cli GET "workstream:instance:{base64_path}"
   ```

3. **Manually refresh daemon:**
   ```bash
   # Publish refresh event
   redis-cli PUBLISH workstream:refresh '{"type":"refresh"}'
   ```

## Updating the Plugin

When you make changes to the plugin:

```bash
cd packages/workstream-opencode-plugin

# Rebuild
npm run build

# Restart OpenCode in your project
# The plugin will automatically reload with new code
```

## Uninstalling

To remove the plugin:

### Global Installation

```bash
rm ~/.config/opencode/plugin/workstream.ts
```

### Project-Specific Installation

```bash
rm .opencode/plugin/workstream.ts
```

## Next Steps

- Read the [README.md](./README.md) for feature documentation
- Check the [examples](./examples/) directory for configuration examples
- View events in real-time using the Raycast Event Viewer
- Monitor sessions in the Workstream Dashboard

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review workstream-daemon logs
3. Check Redis with `redis-cli MONITOR` to see all events
4. Open an issue in the monorepo

## Development Mode

For plugin development:

```bash
# Watch mode (auto-rebuild on changes)
cd packages/workstream-opencode-plugin
npm run dev

# In another terminal, test with OpenCode
cd /path/to/test/project
opencode
```

Every file save will trigger a rebuild, and OpenCode will use the updated code on next session.
