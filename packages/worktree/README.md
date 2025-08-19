# @adamhancock/worktree

A CLI tool for managing Git worktrees with automated setup for development environments.

## Features

- Interactive branch selection from remote branches
- Automatic worktree creation with proper branch handling
- Copies `.env` files from the main repository
- Auto-detects package manager (pnpm, yarn, npm, bun) and installs dependencies
- Opens the new worktree in VS Code
- Configurable via JSON config files

## Installation

### Global installation
```bash
npm install -g @adamhancock/worktree
```

### One-time usage with npx
```bash
npx @adamhancock/worktree
```

## Usage

### Interactive branch selection
```bash
worktree
# or with npx
npx @adamhancock/worktree
```

### Create worktree for a specific branch
```bash
worktree feature/new-feature
# or with npx
npx @adamhancock/worktree feature/new-feature
```

## How it works

1. Fetches latest branches from origin
2. Creates a new worktree in `../assurix-{branch-name}`
3. Handles existing local branches, remote branches, or creates new branches
4. Sets up branch tracking (without auto-pushing new branches)
5. Copies all `.env` files from the original repository
6. Auto-detects package manager and installs dependencies
7. Opens the new worktree in VS Code

## Configuration

You can customize the behavior by creating a `.worktreerc.json` file in your project root or home directory. The tool will look for config files in this order:

1. `./.worktreerc.json` (project root)
2. `./.worktreerc` (project root)
3. `~/.worktreerc.json` (home directory)
4. `~/.worktreerc` (home directory)

### Example configuration

```json
{
  "vscode": {
    "command": "code",
    "args": ["--new-window", "--goto"],
    "open": true
  },
  "worktree": {
    "prefix": "myproject",
    "location": "../worktrees/{prefix}-{branch}"
  },
  "git": {
    "fetch": true,
    "remote": "origin",
    "defaultBranch": "main",
    "pushNewBranches": false
  },
  "env": {
    "copy": true,
    "patterns": [".env*", "config.local.js"],
    "exclude": [".env.example", ".env.test"]
  },
  "packageManager": {
    "install": true,
    "force": "pnpm",
    "command": null
  },
  "hooks": {
    "postCreate": [
      "echo 'Worktree created!'",
      "npm run prepare"
    ]
  }
}
```

### Configuration options

#### VS Code
- `vscode.command`: The command to launch VS Code (default: `"code"`)
- `vscode.args`: Additional arguments to pass to VS Code (default: `[]`)
- `vscode.open`: Whether to open VS Code after creating worktree (default: `true`)

#### Worktree
- `worktree.prefix`: Prefix for worktree directory names (default: `"assurix"`)
- `worktree.location`: Custom location pattern for worktrees. Supports placeholders:
  - `{prefix}`: The configured prefix
  - `{branch}`: The branch name with slashes replaced by hyphens
  - `{original-branch}`: The original branch name with slashes

#### Git
- `git.fetch`: Whether to fetch before creating worktree (default: `true`)
- `git.remote`: Remote name to use (default: `"origin"`)
- `git.defaultBranch`: Default branch for new branches (default: `"main"`)
- `git.pushNewBranches`: Auto-push new branches to remote (default: `false`)

#### Environment Files
- `env.copy`: Whether to copy env files (default: `true`)
- `env.patterns`: File patterns to copy (default: `[".env*"]`)
- `env.exclude`: Patterns to exclude from copying (default: `[]`)

#### Package Manager
- `packageManager.install`: Whether to auto-install dependencies (default: `true`)
- `packageManager.force`: Force specific package manager: `"npm"`, `"yarn"`, `"pnpm"`, or `"bun"`
- `packageManager.command`: Custom install command (overrides auto-detection)

#### Hooks
- `hooks.postCreate`: Array of commands to run after worktree creation. Supports template variables:
  - `{branch}`: The branch name (e.g., `feature/new-feature`)
  - `{safeBranch}`: Branch name with slashes replaced by hyphens (e.g., `feature-new-feature`)
  - `{worktreePath}`: Absolute path to the worktree directory
  - `{originalDir}`: Path to the original repository
  - `{prefix}`: The configured worktree prefix
  - `{remote}`: The git remote name (e.g., `origin`)
  - `{defaultBranch}`: The default branch name (e.g., `main`)

Example with variables:
```json
{
  "hooks": {
    "postCreate": [
      "echo 'Setting up worktree for branch {branch}'",
      "npx zx scripts/setup.mjs --branch {branch} --path {worktreePath}",
      "npm run configure:{safeBranch}"
    ]
  }
}
```

## Requirements

- Git
- Node.js
- Package manager (pnpm, yarn, npm, or bun)
- VS Code (optional, for auto-opening)