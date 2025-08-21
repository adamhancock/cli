# Lasso

A CLI tool to read the Caddy API and interactively open configured hosts in your browser. It also checks backend health and can clean up offline hosts.

## Installation

```bash
npm install -g @adamhancock/lasso
```

## Usage

### Interactive Mode (Default)
```bash
lasso
```

This will fetch all hosts from your Caddy server, check their backend health, and present an interactive searchable menu. Features:
- Type to filter hosts in real-time
- Hosts starting with your search term appear first
- Select hosts to open in browser or VSCode
- Auto-refreshes every 30 seconds
- Quick access to refresh (r) and cleanup (c) actions

### List Mode
```bash
lasso --list
# or
lasso -l
```

This will list all configured hosts with their backend status. Active hosts with running backends are shown in green, offline hosts in red.

### Cleanup Offline Hosts
```bash
lasso --cleanup
# or
lasso -c
```

This will check backend health for all hosts and offer to remove offline hosts from your Caddy configuration. You'll be prompted to confirm before any changes are made.

### Skip Health Checks
```bash
lasso --skip-health
# or
lasso -s
```

Skip backend health checks for faster listing (only works with `--list`).

### Custom Port
```bash
lasso --port 3000
# or
lasso -p 3000
```

By default, lasso connects to the Caddy API on port 2019. Use this option to specify a different port.

## Features

- 🔍 Automatically discovers all configured hosts from Caddy API
- 🏥 Checks backend/upstream server health (not just the proxy)
- ✅ Shows active hosts first with response times
- 🧹 Cleanup command to remove offline hosts from Caddy
- 🎯 Interactive menu with searchable/filterable host selection
- 🔤 Type-to-filter hosts with smart sorting (matches starting with search term appear first)
- 🚀 Opens selected host in browser or VSCode (when worktree path is available)
- 🔄 Auto-refresh every 30 seconds with countdown timer
- 📋 List mode for quick overview of all hosts
- 🎨 Colorized output for better readability
- 📍 Shows upstream/backend servers for each host

## Requirements

- Caddy server running with API enabled (default port 2019)
- Node.js 18 or higher

## License

MIT