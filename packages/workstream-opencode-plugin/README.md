# Workstream OpenCode Plugin

Integrate OpenCode with your Workstream development environment for enhanced productivity, real-time monitoring, and intelligent guardrails.

## 🎯 Features

### Core Capabilities
- **📊 Event Tracking**: Track all OpenCode sessions, tool usage, and file edits
- **🛠️ Custom Tools**: Access PR status, Caddy hosts, Spotlight errors directly from Claude
- **🛡️ Safety Guardrails**: Prevent dangerous operations on protected branches
- **📈 Session Analytics**: Track costs, time, and productivity metrics
- **🔔 Smart Notifications**: Get alerted on errors, cost thresholds, and session events
- **🔄 Bi-directional Control**: Control OpenCode from Raycast/Dashboard (future)
- **🧠 Context Injection**: Auto-include relevant workstream data in prompts (future)

### Custom Tools Available

```typescript
// Check PR status
checkPRStatus()

// Get Caddy development URL
getCaddyHost()

// Check Spotlight errors
getSpotlightErrors()

// Get complete workstream status
getWorkstreamStatus()
```

### Safety Features

- Protected branch warnings (main, master, production)
- Destructive command blocking (rm -rf, drop table, etc.)
- Uncommitted changes warnings
- Concurrent session limits

## 📦 Installation

### 1. Install dependencies

```bash
cd packages/workstream-opencode-plugin
npm install
npm run build
```

### 2. Link to your OpenCode config

```bash
# Global installation (all projects)
mkdir -p ~/.config/opencode/plugin
ln -s $(pwd)/.opencode/plugin/workstream.ts ~/.config/opencode/plugin/

# Or per-project
mkdir -p /path/to/project/.opencode/plugin
ln -s $(pwd)/.opencode/plugin/workstream.ts /path/to/project/.opencode/plugin/
```

### 3. Ensure workstream daemon is running

```bash
cd packages/workstream-daemon
npm start
```

### 4. Verify Redis connection

```bash
redis-cli ping
# Should return: PONG
```

## ⚙️ Configuration

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
    "contextInjection": true,
    "safetyGuards": true,
    "analytics": true,
    "notifications": true,
    "biDirectionalControl": true
  },
  "analytics": {
    "costThreshold": 5.0,
    "timeThreshold": 30,
    "errorThreshold": 10
  },
  "safety": {
    "protectedBranches": ["main", "master", "production"],
    "requireCleanBranch": false,
    "confirmDestructiveCommands": [
      "rm -rf",
      "drop table",
      "git reset --hard"
    ],
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

See `examples/workstream-config.json` for a complete example.

## 🚀 Usage

### Using Custom Tools

In your OpenCode session:

```
Can you check the PR status?

> Using checkPRStatus tool...
> PR #123: Add feature X
> State: OPEN
> Checks (success):
>   ✅ Passing: 15
>   ❌ Failing: 0
>   ⏳ Pending: 0
```

```
What's the dev URL for this workspace?

> Using getCaddyHost tool...
> Caddy Host: https://my-app.local.dev
> Host Name: my-app.local.dev
```

### Monitoring in Dashboard

The workstream dashboard will show:
- Active OpenCode sessions
- Real-time tool usage
- Cost tracking
- Session duration
- Error counts

### Viewing Events

Use the Raycast Event Viewer to see all OpenCode activity:
- Session lifecycle
- Tool executions
- File edits
- Safety warnings

## 🏗️ Architecture

```
OpenCode Plugin
     ↓
   Redis
     ↓
Workstream Daemon
     ↓
┌─────────────┬──────────────┬─────────────┐
│  Dashboard  │   Raycast    │  Event Store│
└─────────────┴──────────────┴─────────────┘
```

### Event Flow

1. OpenCode executes a tool (e.g., bash, write, read)
2. Plugin captures the event
3. Event published to Redis channels:
   - `workstream:opencode` - OpenCode-specific events
   - `workstream:events:new` - Event store
   - `workstream:claude` - Compatibility with VSCode Claude tracking
4. Workstream daemon receives and processes events
5. Events stored in SQLite database
6. Dashboard/Raycast display real-time updates

## 🔧 Development

### Build

```bash
npm run build
```

### Watch mode

```bash
npm run dev
```

### Testing

```bash
# Terminal 1: Start daemon
cd ../workstream-daemon
npm start

# Terminal 2: Start OpenCode with plugin
cd /path/to/project
opencode
```

## 📝 Implementation Status

### ✅ Completed
- [x] Event tracking system
- [x] Redis pub/sub integration
- [x] Session analytics
- [x] Safety guardrails
- [x] Custom tools infrastructure
- [x] Notification system
- [x] Command listener (bi-directional control)
- [x] Context injector

### 🚧 Pending OpenCode Plugin API
The following features are implemented but require OpenCode plugin API support:
- [ ] Custom tool integration (waiting for `@opencode-ai/plugin` package)
- [ ] Session pause/resume
- [ ] Context injection into prompts
- [ ] Event hook registration

### 📋 Future Enhancements
- [ ] Cost tracking with actual API usage
- [ ] Session replay functionality
- [ ] Advanced analytics dashboard
- [ ] Project-specific automation rules
- [ ] Integration with Linear/Jira for error tickets
- [ ] Slack notifications

## 🐛 Troubleshooting

### Plugin not loading

1. Check plugin location:
```bash
ls ~/.config/opencode/plugin/workstream.ts
# or
ls .opencode/plugin/workstream.ts
```

2. Check OpenCode logs:
```bash
opencode --verbose
```

### Redis connection errors

1. Verify Redis is running:
```bash
redis-cli ping
```

2. Check daemon logs:
```bash
cd packages/workstream-daemon
npm start
```

### Tools not working

1. Ensure daemon is running and tracking your workspace
2. Check Redis for instance data:
```bash
redis-cli keys "workstream:instance:*"
```

3. Verify Redis channels are publishing:
```bash
redis-cli SUBSCRIBE workstream:opencode
```

## 📚 API Reference

### Event Types

#### Session Events
- `opencode_session_created` - New session started
- `opencode_session_active` - Session activity detected
- `opencode_session_idle` - Session idle for 5+ minutes
- `opencode_session_error` - Session encountered error
- `opencode_session_compacting` - Session compacting context

#### Tool Events
- `opencode_tool_bash` - Bash command executed
- `opencode_tool_read` - File read operation
- `opencode_tool_write` - File write operation
- `opencode_tool_edit` - File edit operation

#### File Events
- `opencode_file_edited` - File edited by OpenCode

#### Safety Events
- `opencode_safety_warning` - Safety rule triggered (warning)
- `opencode_safety_blocked` - Operation blocked by safety rule

### Redis Channels

- `workstream:opencode` - OpenCode-specific events
- `workstream:opencode:control` - Control commands to OpenCode
- `workstream:events:new` - All events (for event store)
- `workstream:notifications` - User notifications

### Redis Keys

- `workstream:opencode:session:{sessionId}` - Session data
- `workstream:instance:{base64_path}` - Workstream instance data

## 🤝 Contributing

This is part of the Workstream monorepo. See the main README for contribution guidelines.

## 📄 License

MIT

## 🙏 Acknowledgments

Built for integration with:
- [OpenCode](https://opencode.ai) - The best coding agent
- Workstream - Development workflow orchestration
- Redis - Event pub/sub backbone
