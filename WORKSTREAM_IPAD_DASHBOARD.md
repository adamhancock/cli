# Workstream iPad Dashboard

A complete solution for monitoring your development workflow on iPad. This system connects to the Workstream daemon via a bridge API server and displays real-time status of all your VSCode instances.

## Overview

The Workstream iPad Dashboard consists of two main components:

1. **API Server** (`packages/workstream-ipad-api`) - Node.js/Express server that bridges Redis to iOS
2. **iPad App** (`packages/workstream-ipad-app`) - SwiftUI app for beautiful real-time monitoring

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  VSCode Instances                   │
│         (Multiple worktrees/projects)               │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ lsof polling + VSCode Extension events
                   ↓
         ┌─────────────────────┐
         │ Workstream Daemon   │
         │ (Redis Pub/Sub)     │
         └──────────┬──────────┘
                    │
                    │ Redis pub/sub channels
                    ↓
         ┌─────────────────────┐
         │ iPad API Server     │
         │ (Express + WS)      │
         └──────────┬──────────┘
                    │
                    │ WebSocket + REST
                    ↓
         ┌─────────────────────┐
         │ iPad Dashboard App  │
         │ (SwiftUI)           │
         └─────────────────────┘
```

## Quick Start

### 1. Start the API Server

```bash
# Install dependencies
cd packages/workstream-ipad-api
pnpm install

# Run in development mode
pnpm dev
```

The server will start on http://localhost:3000

### 2. Open the iPad App

```bash
# Open in Xcode
cd packages/workstream-ipad-app
open WorkstreamDashboard/WorkstreamDashboard.xcodeproj
```

Then:
1. Select an iPad simulator or device
2. Press Cmd+R to build and run
3. The app will connect to `ws://localhost:3000` by default

### 3. Configure for Remote Access

If running the API server on a different machine:

**On the server machine:**

```bash
# Find your local IP
ifconfig | grep "inet " | grep -v 127.0.0.1

# Start the server
cd packages/workstream-ipad-api
PORT=3000 pnpm dev
```

**In the iPad app:**

1. Tap the gear icon (Settings)
2. Change the WebSocket URL to `ws://<your-ip>:3000`
3. Tap Done

## Features

### What You Can Monitor

- **VSCode Instances** - All open VSCode windows across worktrees
- **Git Status** - Branch, ahead/behind, dirty state, last commit
- **Pull Requests** - PR number, status, CI checks (pass/fail/pending)
- **Claude Code** - Active sessions, status (working/waiting/idle)
- **File Activity** - Saves, dirty files, active file
- **Terminals** - Count, active terminals, purposes
- **Debug Sessions** - Active debuggers
- **Window Focus** - Which VSCode window is active
- **Chrome Windows** - Associated browser tabs (if configured)

### Real-time Updates

The dashboard updates in real-time via WebSocket when:

- New VSCode instances are opened
- Git status changes (commits, branch switches)
- PRs are created or CI checks complete
- Claude Code starts/stops working
- Files are saved or modified
- Terminals are created
- Windows gain/lose focus

### Beautiful UI

- Clean card-based layout
- Adaptive grid for iPad screen sizes
- Color-coded status indicators
- Quick stats overview
- Tap cards for detailed views
- Connection status monitoring

## API Reference

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/instances` | GET | Fetch all instances |
| `/api/chrome/windows` | GET | Fetch Chrome windows |
| `/api/refresh` | POST | Trigger refresh |

### WebSocket

Connect to `ws://localhost:3000/ws` to receive real-time updates.

**Message Types:**
- `instances` - Instance data updates
- `refresh` - Refresh triggered
- `claude` - Claude Code events
- `heartbeat` - VSCode extension heartbeat
- `chrome` - Chrome window updates
- `notification` - System notifications

See [API README](packages/workstream-ipad-api/README.md) for full documentation.

## Configuration

### API Server Environment Variables

```bash
PORT=3000              # Server port (default: 3000)
REDIS_HOST=localhost   # Redis host (default: localhost)
REDIS_PORT=6379        # Redis port (default: 6379)
```

### iPad App Settings

Configurable via in-app Settings (gear icon):

- **WebSocket URL** - API server endpoint
- **Connection Status** - View current connection state
- **Error Messages** - See connection errors

Settings are persisted via UserDefaults.

## Development

### Project Structure

```
packages/
├── workstream-ipad-api/
│   ├── src/
│   │   ├── index.ts          # Main server
│   │   └── types.ts          # TypeScript types
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
│
└── workstream-ipad-app/
    └── WorkstreamDashboard/
        ├── WorkstreamDashboard.xcodeproj/
        └── WorkstreamDashboard/
            ├── WorkstreamDashboardApp.swift
            ├── ContentView.swift
            ├── InstanceCardView.swift
            ├── DashboardViewModel.swift
            ├── WebSocketClient.swift
            ├── Models.swift
            └── Assets.xcassets/
```

### Adding Features

**Backend (API Server):**

1. Update types in `src/types.ts`
2. Add endpoints in `src/index.ts`
3. Subscribe to new Redis channels if needed
4. Update README with new endpoints

**Frontend (iPad App):**

1. Update models in `Models.swift`
2. Extend views to display new data
3. Update ViewModel for new computed properties
4. Test on iPad simulator

### Building for Production

**API Server:**

```bash
cd packages/workstream-ipad-api
pnpm build    # Compiles TypeScript
pnpm start    # Runs compiled code
```

**iPad App:**

1. Open in Xcode
2. Select Product > Archive
3. Distribute to TestFlight or App Store

## Deployment

### Running API Server as a Service

**macOS (LaunchAgent):**

Create `~/Library/LaunchAgents/com.adamhancock.workstream-ipad-api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.adamhancock.workstream-ipad-api</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/cli/packages/workstream-ipad-api/dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/workstream-ipad-api.err</string>
    <key>StandardOutPath</key>
    <string>/tmp/workstream-ipad-api.out</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.adamhancock.workstream-ipad-api.plist
```

### iPad App Distribution

- **Development**: Run directly from Xcode
- **TestFlight**: Archive and upload to App Store Connect
- **Enterprise**: Use enterprise distribution certificate
- **Personal**: Install via Xcode on your device

## Troubleshooting

### API Server Issues

**Server won't start:**
- Check if port 3000 is already in use: `lsof -i :3000`
- Verify Redis is running: `redis-cli ping`
- Check logs for errors

**No data from daemon:**
- Ensure Workstream daemon is running
- Verify Redis connection: `redis-cli keys "workstream:*"`
- Check daemon is publishing: `redis-cli subscribe workstream:updates`

### iPad App Issues

**Cannot connect:**
- Verify API server is running: `curl http://localhost:3000/health`
- Check WebSocket URL in Settings
- Ensure device can reach server (use IP if on different network)
- Check firewall settings

**Stale data:**
- Check connection status (green dot)
- Verify "Last Update" timestamp
- Tap refresh button
- Check API server logs

**App crashes:**
- Check Xcode console for errors
- Verify all models match API types
- Update to latest iOS/Xcode

## Security Considerations

- API server has no authentication (intended for local network use)
- For public exposure, add authentication middleware
- Use HTTPS/WSS for encrypted connections
- Consider VPN for remote access
- Don't expose Redis directly to network

## Performance

- WebSocket connection is persistent and lightweight
- Updates are pushed only when data changes
- Redis TTL prevents stale data (30 second expiry)
- API server caches data between requests
- iPad app uses efficient SwiftUI updates

## Contributing

When contributing:

1. Update types in both TypeScript and Swift
2. Maintain backward compatibility
3. Add tests for new features
4. Update documentation
5. Follow existing code style

## License

ISC

## Support

For issues or questions:

- Check the package READMEs
- Review troubleshooting section
- Check server/app logs
- Verify Workstream daemon is working

## Future Enhancements

- [ ] Authentication/authorization
- [ ] HTTPS/WSS support
- [ ] Push notifications
- [ ] Historical data/charts
- [ ] Multi-user support
- [ ] Custom alerts/thresholds
- [ ] Action buttons (open VSCode, view PR)
- [ ] Search and filtering
- [ ] Landscape layout optimization
- [ ] iPhone support
