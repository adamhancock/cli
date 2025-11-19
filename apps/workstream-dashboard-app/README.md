# Workstream Dashboard (iPad App)

A real-time dashboard for monitoring your VS Code workspaces, built with React Native and Expo.

## Features

- **Real-time Updates**: Live status updates via WebSocket connection to workstream-daemon
- **Git Status**: See branch information, uncommitted changes, and sync status
- **PR Status**: Monitor pull request state and CI check results
- **Claude Code Status**: Track Claude Code sessions (working, waiting, idle, finished)
- **iPad Optimized**: Landscape layout designed for iPad
- **Pull to Refresh**: Manual refresh support

## Prerequisites

1. **workstream-daemon** must be running with WebSocket server enabled (port 9995)
2. **Expo Go** app installed on your iPad (or iOS Simulator)
3. iPad and Mac must be on the same WiFi network

## Installation

```bash
cd apps/workstream-dashboard
npm install
```

## Running the App

### On iPad (Same Network)

1. Start the workstream daemon (if not already running):
   ```bash
   cd packages/workstream-daemon
   npm run start
   ```

2. Start the Expo development server:
   ```bash
   cd apps/workstream-dashboard
   npm start
   ```

3. Open **Expo Go** on your iPad

4. Scan the QR code displayed in the terminal

5. The app will connect to your Mac's WebSocket server on port 9995

### On iOS Simulator

```bash
npm run ios
```

### Changing the Server URL

By default, the app connects to `http://localhost:9995`. If your Mac has a different IP address on your network, update the `serverUrl` in `App.tsx`:

```typescript
const [serverUrl] = useState('http://YOUR_MAC_IP:9995');
```

You can find your Mac's IP address with:
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

## Project Structure

```
apps/workstream-dashboard/
├── App.tsx                          # Main application component
├── src/
│   ├── components/
│   │   ├── InstanceCard.tsx         # Card displaying workspace instance
│   │   ├── InstanceGrid.tsx         # Grid layout for cards
│   │   └── StatusBadge.tsx          # Status indicator badges
│   ├── hooks/
│   │   └── useWorkstream.ts         # WebSocket connection hook
│   └── types/
│       └── index.ts                 # TypeScript type definitions
├── app.json                         # Expo configuration
└── package.json
```

## Status Indicators

### Git Status
- **Green (Clean)**: No uncommitted changes
- **Orange (Dirty)**: Uncommitted changes present

### PR Status
- **Green (Checks Passed)**: All CI checks passing
- **Red (Checks Failed)**: One or more CI checks failing
- **Orange (Checks Pending)**: CI checks in progress
- **Red (Conflicts)**: Merge conflicts detected
- **Blue (Open)**: PR is open without checks
- **Gray (Merged/Closed)**: PR merged or closed

### Claude Code Status
- **Blue (Working)**: Claude is actively working
- **Orange (Waiting)**: Claude is waiting for user input
- **Gray (Idle)**: Claude process is idle
- **Green (Finished)**: Claude recently finished a task

## Troubleshooting

### "Connection error" Message

1. Verify workstream daemon is running:
   ```bash
   lsof -i :9995
   ```

2. Check that WebSocket server started:
   ```bash
   # Look for "WebSocket Server listening on port 9995" in daemon logs
   ```

3. Ensure iPad and Mac are on the same network

4. Try using your Mac's IP address instead of `localhost`

### No Instances Showing

1. Open at least one VS Code workspace
2. Wait 5 seconds for the daemon to detect it
3. Pull down to refresh in the app

### Real-time Updates Not Working

1. Check Redis is running:
   ```bash
   redis-cli ping
   ```

2. Restart the workstream daemon

## Development

```bash
# Start with web preview
npm run web

# Start iOS simulator
npm run ios

# Clear cache and restart
npm start -- --clear
```

## Tech Stack

- React Native
- Expo
- TypeScript
- Socket.IO Client
- Real-time WebSocket connection to workstream-daemon

## Future Enhancements

- Detailed instance view (drill down into single workspace)
- Chrome tabs integration
- Event timeline
- Push notifications for important events
- Dark mode support
- Settings screen for configuring server URL
