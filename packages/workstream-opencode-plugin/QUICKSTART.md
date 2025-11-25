# Quick Start Guide - Workstream OpenCode Plugin

Get up and running with the Workstream OpenCode plugin in 5 minutes!

## Prerequisites Check

```bash
# 1. Redis running?
redis-cli ping
# Expected: PONG

# 2. Workstream daemon running?
ps aux | grep workstream-daemon

# 3. OpenCode installed?
which opencode
```

If any are missing, see [INSTALL.md](./INSTALL.md) for setup instructions.

## 30-Second Setup

```bash
# 1. Build the plugin
cd packages/workstream-opencode-plugin
npm install && npm run build

# 2. Link globally
mkdir -p ~/.config/opencode/plugin
ln -sf $(pwd)/.opencode/plugin/workstream.ts ~/.config/opencode/plugin/

# 3. Verify
ls -la ~/.config/opencode/plugin/workstream.ts

# 4. Start OpenCode in any project
cd /path/to/your/project
opencode
```

Look for initialization message:
```
[Workstream] Plugin initializing...
[Workstream] Connected to Redis
[Workstream] Plugin initialized for: /path/to/your/project
```

## Try It Out

### 1. Check Workstream Status

In OpenCode, ask:
```
Can you check the workstream status?
```

Expected output:
```
Workstream Status for my-project:

📊 Git:
  Branch: feature/my-feature
  Status: 🟢 Clean
  Modified: 0 | Staged: 0 | Untracked: 0

🔀 Pull Request #123:
  Title: Add new feature
  State: OPEN
  Checks: success (15✅ 0❌ 0⏳)

🌐 Caddy:
  URL: https://my-project.local.dev
```

### 2. Check PR Status

```
What's the status of my PR?
```

Expected output:
```
PR #123: Add new feature
State: OPEN
Mergeable: MERGEABLE

Checks (success):
  ✅ Passing: 15
  ❌ Failing: 0
  ⏳ Pending: 0
```

### 3. Get Development URL

```
What's the Caddy URL for this workspace?
```

Expected output:
```
Caddy Host: https://my-project.local.dev
Host Name: my-project.local.dev
```

### 4. Check Spotlight Errors

```
Are there any Spotlight errors?
```

Expected output:
```
Spotlight Status (Port 3456):
Status: 🟢 Online
Errors: 0
Traces: 42
Logs: 156
```

## Verify Events Are Being Tracked

### Option 1: Redis Monitor

In a terminal:
```bash
# Subscribe to OpenCode events
redis-cli SUBSCRIBE workstream:opencode

# You should see events as you use OpenCode:
# 1) "message"
# 2) "workstream:opencode"
# 3) "{\"type\":\"opencode_session_created\",\"timestamp\":...}"
```

### Option 2: Check Redis Keys

```bash
# List OpenCode sessions
redis-cli KEYS "workstream:opencode:session:*"

# View a session
redis-cli GET "workstream:opencode:session:{sessionId}" | jq
```

### Option 3: Workstream Dashboard

Open the workstream dashboard to see:
- Active OpenCode sessions
- Real-time metrics
- Tool usage stats
- Session timeline

## Test Safety Guards

### Protected Branch Warning

```bash
# Switch to main branch
git checkout main
```

In OpenCode, try to edit a file:
```
Can you modify the README file?
```

Expected: Warning message about protected branch

### Destructive Command Block

In OpenCode, try:
```
Can you run: rm -rf /tmp/test
```

Expected: Blocked with safety message

## Monitoring

### View Session Metrics

```bash
# Get session from Redis
redis-cli GET "workstream:opencode:session:{sessionId}" | jq '.metrics'
```

Output:
```json
{
  "toolsUsed": {
    "read": 15,
    "bash": 3,
    "write": 2
  },
  "filesEdited": 2,
  "commandsRun": 3,
  "errorsEncountered": 0,
  "tokensUsed": 12500,
  "estimatedCost": 0.75,
  "duration": 180000
}
```

### Watch Events in Real-Time

```bash
# Monitor all Redis activity
redis-cli MONITOR | grep workstream:opencode
```

### Check Daemon Logs

```bash
cd packages/workstream-daemon
npm start

# Look for OpenCode events:
# 📨 Received message on workstream:opencode: opencode_session_created
# 📨 Received message on workstream:opencode: opencode_tool_bash
```

## Configuration

### Basic Config

Create `.opencode/workstream-config.json` in your project:

```json
{
  "redis": {
    "host": "localhost",
    "port": 6379
  },
  "features": {
    "eventTracking": true,
    "customTools": true,
    "safetyGuards": true
  }
}
```

### Disable Safety Guards (Not Recommended)

```json
{
  "features": {
    "safetyGuards": false
  }
}
```

### Adjust Cost Threshold

```json
{
  "analytics": {
    "costThreshold": 10.0
  }
}
```

## Troubleshooting

### Plugin Not Loading

```bash
# Check symlink
readlink ~/.config/opencode/plugin/workstream.ts

# Rebuild
cd packages/workstream-opencode-plugin
npm run build

# Check build output
ls dist/index.js
```

### Tools Not Working

```bash
# Ensure daemon detected your workspace
cd packages/workstream-daemon
npm start

# Check for instance detection logs:
# 📁 Found 3 VS Code instances
# ✅ my-project (with PR)
```

### No Events in Redis

```bash
# Check Redis connection
redis-cli ping

# Check OpenCode is running
ps aux | grep opencode

# Monitor Redis
redis-cli MONITOR
```

## Next Steps

- **Read the full documentation**: [README.md](./README.md)
- **Detailed installation guide**: [INSTALL.md](./INSTALL.md)
- **Customize configuration**: See `examples/workstream-config.json`
- **View events in Raycast**: Use the Event Viewer command
- **Monitor in Dashboard**: Open the workstream dashboard app

## Getting Help

Common issues:
1. **Plugin not loading**: Check symlink and build output
2. **Tools returning "no instance"**: Ensure daemon is running and workspace is in VSCode
3. **Redis errors**: Verify Redis is running on port 6379
4. **No events**: Check Redis connection and daemon logs

For more help, see [INSTALL.md](./INSTALL.md#troubleshooting)

## What's Next?

Once the plugin is working:

1. **Explore all tools**: `checkPRStatus()`, `getCaddyHost()`, `getSpotlightErrors()`
2. **Monitor sessions**: Use Redis or Dashboard to track activity
3. **Customize safety rules**: Edit configuration for your workflow
4. **Set up notifications**: Configure alert thresholds
5. **View analytics**: Track costs, time, and productivity

Enjoy enhanced OpenCode development with Workstream! 🚀
