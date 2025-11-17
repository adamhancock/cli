# Workstream Dashboard for iPad

A beautiful SwiftUI dashboard app for monitoring your VSCode instances, git status, pull requests, and Claude Code activity in real-time.

## Features

- **Real-time Updates** - WebSocket connection for live data
- **Beautiful Cards** - Clean, modern UI showing all instance details
- **Rich Metadata** - View git status, PR info, Claude sessions, and more
- **Interactive** - Tap cards for detailed views
- **Configurable** - Set custom API endpoint
- **iPad Optimized** - Designed specifically for iPad with adaptive layouts

## Screenshots

The dashboard displays:

- Overview stats (total instances, active, PRs, Claude sessions)
- Instance cards showing:
  - Project name and branch
  - Git status (ahead/behind, dirty state)
  - Pull request status and CI checks
  - Active Claude Code sessions
  - File activity and terminal info
  - Window focus state

## Requirements

- iOS 17.0+
- iPad device or simulator
- Xcode 15.0+
- Workstream iPad API server running

## Setup

### 1. Open in Xcode

```bash
cd packages/workstream-ipad-app
open WorkstreamDashboard/WorkstreamDashboard.xcodeproj
```

### 2. Configure API Endpoint

On first launch, the app defaults to `ws://localhost:3000`. If your API server is running on a different host:

1. Tap the gear icon in the top-right
2. Enter your API server URL (e.g., `ws://192.168.1.100:3000`)
3. Tap Done

The URL is saved and persists across app launches.

### 3. Build and Run

1. Select an iPad simulator or device
2. Press Cmd+R to build and run

## Architecture

```
┌──────────────────┐
│ SwiftUI Views    │
│ - ContentView    │
│ - InstanceCard   │
│ - DetailView     │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ ViewModel        │
│ - State Mgmt     │
│ - Business Logic │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ WebSocket Client │
│ - Connection     │
│ - Message Parser │
└────────┬─────────┘
         │
         │ WebSocket
         ↓
┌──────────────────┐
│ iPad API Server  │
└──────────────────┘
```

## Project Structure

```
WorkstreamDashboard/
├── WorkstreamDashboard.xcodeproj/
└── WorkstreamDashboard/
    ├── WorkstreamDashboardApp.swift   # App entry point
    ├── ContentView.swift              # Main dashboard view
    ├── InstanceCardView.swift         # Instance card component
    ├── DashboardViewModel.swift       # View model
    ├── WebSocketClient.swift          # WebSocket client
    ├── Models.swift                   # Data models
    └── Assets.xcassets/               # App assets
```

## Key Components

### ContentView

Main dashboard with:
- Stats cards (overview)
- Grid of instance cards
- Connection status indicator
- Settings sheet
- Detail view sheet

### InstanceCardView

Displays rich instance information:
- Name and branch
- Git ahead/behind status
- Dirty state indicator
- PR status with checks
- Claude Code sessions
- File activity metrics
- Terminal counts

### DashboardViewModel

Manages:
- WebSocket connection state
- Instance data
- API URL configuration
- Computed statistics

### WebSocketClient

Handles:
- WebSocket connection lifecycle
- Automatic reconnection
- Message parsing
- Real-time updates

## Data Models

All models match the API server's TypeScript types:

- `InstanceWithMetadata` - Complete instance data
- `GitInfo` - Git repository status
- `PRStatus` - Pull request information
- `ClaudeStatus` - Claude Code sessions
- `VSCodeExtensionState` - Editor state
- Plus supporting types for terminals, file activity, etc.

## Usage

### Viewing Instances

The main screen shows all active VSCode instances in a grid layout. Each card displays:

- Project name and current branch
- Git status (commits ahead/behind, dirty files)
- Pull request info and CI check status
- Active Claude Code sessions
- Recent file activity
- Terminal information

### Instance Details

Tap any card to see full details including:

- Complete file path
- Last commit information
- Full PR details with check results
- Editor state (dirty files, terminals, debug sessions)

### Refreshing Data

- Pull down to refresh (coming soon)
- Tap the refresh button in the toolbar
- Data updates automatically via WebSocket

### Settings

Access settings via the gear icon to:
- Configure API endpoint URL
- View connection status
- Check for errors
- Manually connect/disconnect

## Development

### Adding New Features

1. Update models in `Models.swift` if API changes
2. Extend views to display new data
3. Update ViewModel for new computed properties

### Debugging

- Use Xcode's console for WebSocket messages
- Check connection status in Settings
- Verify API server is running and accessible

## Troubleshooting

### Cannot Connect

1. Verify API server is running: `curl http://localhost:3000/health`
2. Check the WebSocket URL in Settings
3. Ensure your device can reach the server (use IP address if on different network)
4. Check for firewall blocking port 3000

### No Data Showing

1. Verify Workstream daemon is running
2. Check Redis is accessible to API server
3. Ensure VSCode instances are open
4. Tap refresh button to force update

### Stale Data

- WebSocket automatically reconnects on connection loss
- Check "Last Update" time in the toolbar
- Manually refresh if needed

## Future Enhancements

- [ ] Pull to refresh
- [ ] Search and filter instances
- [ ] Sort options (by name, activity, etc.)
- [ ] Dark mode support
- [ ] Customizable card layouts
- [ ] Quick actions (open in VSCode, view PR, etc.)
- [ ] Notifications for PR status changes
- [ ] Historical data/charts

## License

ISC
