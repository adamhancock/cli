# @adamhancock/tmuxdev

A CLI tool to manage tmux sessions for development servers, making it easy for tools like Claude to access console logs.

## 🚀 Installation

```bash
npm install -g @adamhancock/tmuxdev
# or
pnpm add -g @adamhancock/tmuxdev
# or
yarn global add @adamhancock/tmuxdev
```

## 📖 Usage

### Quick Commands

```bash
# Quick start - creates/attaches to session for current directory
tmuxdev

# Interactive menu for session management
tmuxdev menu
tmuxdev m        # short alias

# Start and attach to session for current directory
tmuxdev start
tmuxdev s        # short alias

# Attach to existing session for current directory
tmuxdev attach
tmuxdev a        # short alias

# Show help
tmuxdev help
tmuxdev h        # short alias
tmuxdev --help   # or use flags
tmuxdev -h
```

### Default Behavior

When you run `tmuxdev` without arguments, it automatically creates or attaches to a session named after your current directory and git branch (e.g., `myproject-main`, `webapp-feature-auth`).

### Interactive Menu

When you run `tmuxdev menu` (or `tmuxdev m`), you get an interactive menu:

- **Start/Attach to current directory session** - Manages a session named after your current folder and branch
- **Select from existing sessions** - Browse and attach to any running tmux session
- **Kill a session** - Safely terminate tmux sessions
- **Exit** - Quit the tool

## ✨ Features

- **🏷️ Smart Session Naming**: Automatically combines folder and git branch names (e.g., `myproject-main`, `myapp-feature-branch`)
- **🎯 Quick Commands**: Jump straight into work with `tmuxdev s` for instant session start
- **📋 Interactive Menu**: User-friendly interface with arrow key navigation
- **🔄 Session Management**: Create, attach, list, and kill tmux sessions effortlessly
- **🚀 Dev Server Integration**: Automatically runs `npm run dev` when creating new sessions
- **⚡ Fast Context Switching**: Quickly jump between different project sessions
- **🛡️ Graceful Exit Handling**: Properly handles Ctrl+C interruptions

## 🎮 Tmux Controls

Once attached to a session:

- `Ctrl+B then D` - Detach from session (keeps it running)
- `Ctrl+B then [` - Enter scroll/copy mode
- `Ctrl+B then %` - Split pane vertically
- `Ctrl+B then "` - Split pane horizontally
- `Ctrl+B then arrow keys` - Navigate between panes

## 🔧 Requirements

- Node.js 16+
- tmux installed on your system
- A project with a `dev` script in package.json (or modify the source to use your preferred command)

## 💡 Why tmuxdev?

This tool was created to solve a specific problem: when using AI assistants like Claude to help with development, they can't see your terminal output. By running your dev server in a tmux session, you can easily share logs and error messages by:

1. Starting a session with `tmuxdev s`
2. Letting your dev server run
3. Copying relevant output to share with your AI assistant
4. Detaching with `Ctrl+B then D` to keep it running

## 🤝 Contributing

Contributions are welcome! Feel free to:

- Report bugs
- Suggest new features
- Submit pull requests

GitHub: [https://github.com/adamhancock/tmuxdev](https://github.com/adamhancock/tmuxdev)

## 📄 License

MIT © Adam Hancock