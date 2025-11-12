# Workstream for Raycast

Quick switcher for VS Code windows with git status, PR info, and Claude Code integration.

## Features

- **VS Code Window Detection**: Automatically finds all open VS Code instances
- **Git Integration**: Shows branch, sync status (ahead/behind), and working directory state
- **GitHub PR Status**: Displays PR information and CI check results
- **Claude Code Detection**: Shows if Claude Code is active and whether it's working or idle
- **Quick Switching**: Focus VS Code windows with keyboard shortcuts
- **Smart Caching**: Caches metadata for 30 seconds for instant subsequent loads
- **Progressive Loading**: Shows basic info immediately, enriches with metadata in background

## Requirements

- macOS (uses `lsof` and AppleScript for VS Code window management)
- [Raycast](https://www.raycast.com/) installed
- [VS Code](https://code.visualstudio.com/) installed
- [GitHub CLI](https://cli.github.com/) (`gh`) for PR status (optional)
- Git command line tools

## Installation

### From Source

1. Clone this repository or navigate to this package directory:
   ```bash
   cd packages/workstream-raycast-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Import to Raycast:
   ```bash
   npm run dev
   ```
   This will open Raycast's extension development mode and you can test the extension.

### Publishing to Raycast Store (Future)

To publish this extension to the Raycast Store:

```bash
npm run publish
```

## Usage

1. Open Raycast (Cmd+Space or your configured hotkey)
2. Type "Switch VS Code Window" or "Workstream"
3. Browse through your open VS Code instances
4. Use arrow keys to navigate
5. Press Enter to switch to the selected window
6. Press Tab to show detailed information panel

### Keyboard Shortcuts

- **Enter**: Switch to the selected VS Code window
- **Cmd+R**: Refresh (uses cache if fresh)
- **Cmd+Shift+R**: Clear cache and force refresh
- **Cmd+O**: Open PR in browser (if PR exists)
- **Cmd+Shift+F**: Show in Finder
- **Cmd+Shift+C**: Copy workspace path

## What Information is Displayed

### List View

Each VS Code instance shows:
- **Icon**: Status indicator (success/failure/pending for PR checks)
- **Title**: Workspace folder name
- **Subtitle**: Git branch, sync status, PR number
- **Accessories**:
  - Claude Code indicator (⚡) if active
  - CI check status (passing/total)
  - Number of uncommitted changes

### Detail View

The detail panel shows:
- Full workspace path
- Git status (branch, remote, sync status, changes)
- Last commit information
- Pull request details with link
- CI check status breakdown
- Claude Code session information

## Performance & Caching

The extension uses intelligent caching to provide instant results:

- **First load**: ~2-3 seconds (fetches all data)
- **Subsequent loads**: < 100ms (uses cache)
- **Cache lifetime**: 30 seconds
- **Auto-refresh**: Cache automatically expires after 30 seconds
- **Manual refresh**: Cmd+R to force refresh, Cmd+Shift+R to clear cache

The extension loads data progressively:
1. Shows workspace names immediately
2. Enriches with git info (~500ms)
3. Adds PR status and checks (~2-3s)

This means you see results instantly on subsequent invocations!

## How It Works

### VS Code Instance Detection

Uses `lsof` to find VS Code process working directories:
```bash
lsof -c "Code Helper" -a -d cwd -Fn
```

### Window Switching

Uses AppleScript to focus specific VS Code windows by matching the folder name in the window title. Falls back to `code` CLI command if window matching fails.

### Git Information

Runs git commands in each workspace directory to gather:
- Current branch name
- Remote tracking branch
- Ahead/behind commit counts
- Working directory status (modified, staged, untracked files)
- Last commit details

### PR Status

Uses GitHub CLI (`gh`) to fetch:
- PR number, title, and URL
- PR state (open, merged, closed)
- CI check results and status

### Claude Code Detection

Checks for active Claude Code sessions by:
1. Inspecting Claude process PIDs and their working directories
2. Reading lock files from `~/.claude/ide/` directory
3. Verifying processes are still running
4. Monitoring CPU usage to detect if Claude is actively working (>5% CPU)
5. Tracking lock file modification time for last activity

**Status Indicators:**
- 🔥 **Working** (Purple): Claude Code is actively processing (high CPU usage)
- 💤 **Idle** (Gray): Claude Code is running but idle (low CPU usage)

## Development

### Project Structure

```
src/
├── index.tsx           # Main command component
├── types/
│   └── index.ts        # TypeScript type definitions
└── utils/
    ├── vscode.ts       # VS Code instance detection and switching
    ├── git.ts          # Git information gathering
    ├── github.ts       # GitHub PR status fetching
    └── claude.ts       # Claude Code session detection
```

### Running in Development Mode

```bash
npm run dev
```

This opens Raycast in development mode where you can test changes in real-time.

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
npm run fix-lint  # Auto-fix issues
```

## Troubleshooting

### No VS Code instances detected

- Make sure VS Code is running with at least one folder/workspace open
- The extension uses `lsof` which requires VS Code to be actively running with open folders

### PR status not showing

- Ensure GitHub CLI is installed: `brew install gh`
- Authenticate with GitHub: `gh auth login`
- Make sure the workspace is a GitHub repository with a remote

### Window switching not working

- The extension tries to match windows by folder name in the window title
- If matching fails, it falls back to opening the folder with `code` command
- Ensure the `code` command is available in your PATH

### Claude Code not detected

- Claude Code must be actively running in the workspace
- The detection checks both process PIDs and lock files in `~/.claude/ide/`

## Related Projects

This Raycast extension is based on [workstream](../workstream), a terminal-based CLI tool for the same purpose.

## License

MIT

## Author

Adam Hancock
