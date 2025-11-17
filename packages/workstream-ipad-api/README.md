# Workstream iPad API

REST and WebSocket API server that bridges Redis pub/sub data from the Workstream daemon to iOS clients.

## Features

- **REST API** - HTTP endpoints for fetching VSCode instance data
- **WebSocket Support** - Real-time updates via WebSocket connections
- **Redis Integration** - Subscribes to Workstream daemon pub/sub channels
- **CORS Enabled** - Cross-origin requests supported

## Installation

```bash
cd packages/workstream-ipad-api
pnpm install
```

## Usage

### Development Mode

```bash
pnpm dev
```

Runs the server with hot-reload using `tsx watch`.

### Production Mode

```bash
pnpm build
pnpm start
```

### Environment Variables

- `PORT` - Server port (default: 3000)
- `REDIS_HOST` - Redis host (default: localhost)
- `REDIS_PORT` - Redis port (default: 6379)

Example:

```bash
PORT=8080 REDIS_HOST=192.168.1.100 pnpm dev
```

## API Endpoints

### REST Endpoints

#### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": 1234567890
}
```

#### `GET /api/instances`

Fetch all VSCode instances with metadata.

**Response:**
```json
{
  "instances": [
    {
      "name": "my-project",
      "path": "/Users/adam/projects/my-project",
      "branch": "main",
      "isGitRepo": true,
      "gitInfo": {
        "branch": "main",
        "ahead": 2,
        "behind": 0,
        "isDirty": true
      },
      "prStatus": {
        "number": 123,
        "title": "Add new feature",
        "state": "OPEN",
        "checks": {
          "total": 5,
          "passing": 4,
          "failing": 1,
          "pending": 0
        }
      },
      "claudeStatus": {
        "hasActiveSessions": true,
        "sessions": [
          {
            "status": "working",
            "pid": 12345,
            "terminalName": "claude"
          }
        ]
      }
    }
  ],
  "timestamp": 1234567890
}
```

#### `GET /api/chrome/windows`

Fetch Chrome window information.

**Response:**
```json
{
  "windows": [
    {
      "windowId": 1,
      "title": "GitHub",
      "url": "https://github.com",
      "tabs": [
        {
          "title": "Repository",
          "url": "https://github.com/user/repo"
        }
      ]
    }
  ],
  "timestamp": 1234567890
}
```

#### `POST /api/refresh`

Trigger a manual refresh of all instances.

**Response:**
```json
{
  "success": true
}
```

### WebSocket Endpoint

#### `ws://localhost:3000/ws`

Connect to receive real-time updates.

**Message Format:**
```json
{
  "type": "instances",
  "data": {
    "instances": [...],
    "timestamp": 1234567890
  },
  "timestamp": 1234567890
}
```

**Client -> Server Messages:**

Refresh instances:
```json
{
  "type": "refresh"
}
```

## Data Flow

```
┌─────────────────┐
│ Workstream      │
│ Daemon          │
│ (Redis Pub/Sub) │
└────────┬────────┘
         │
         │ Publishes to:
         │ - workstream:updates
         │ - workstream:claude
         │ - workstream:vscode:heartbeat
         │ - workstream:chrome:updates
         ↓
┌─────────────────┐
│ iPad API Server │
│ (This Package)  │
└────────┬────────┘
         │
         │ HTTP REST + WebSocket
         ↓
┌─────────────────┐
│ iPad App        │
│ (SwiftUI)       │
└─────────────────┘
```

## Architecture

The server:

1. **Connects to Redis** - Subscribes to Workstream pub/sub channels
2. **Serves REST API** - Provides HTTP endpoints for fetching data
3. **Manages WebSockets** - Broadcasts updates to connected clients
4. **Fetches from Redis** - Retrieves instance data from Redis keys
5. **Broadcasts Updates** - Sends real-time updates to all WebSocket clients

## Development

### Type Safety

All data structures are strongly typed in `src/types.ts` to match the Workstream daemon's data models.

### Redis Keys

The server reads from these Redis keys:

- `workstream:instances:list` - Set of instance paths
- `workstream:instance:{base64path}` - Instance metadata (JSON)
- `workstream:vscode:state:{base64path}` - VSCode extension state (JSON)
- `workstream:chrome:windows` - Chrome window data (JSON)

### Redis Channels

Subscribes to these pub/sub channels:

- `workstream:updates` - Instance list updates
- `workstream:refresh` - Manual refresh requests
- `workstream:claude` - Claude Code events
- `workstream:vscode:heartbeat` - VSCode extension heartbeats
- `workstream:chrome:updates` - Chrome window updates
- `workstream:notifications` - System notifications

## License

ISC
