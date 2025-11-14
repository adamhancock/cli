# devctl

A powerful development environment manager for multi-worktree projects. Simplifies the management of development environments by automatically handling:

- **Caddy reverse proxy routes** for subdomain-based worktrees
- **Database isolation** with automatic PostgreSQL database creation per worktree
- **Port allocation** using deterministic hashing to avoid conflicts
- **Environment file management** with automatic .env updates
- **MCP integration** for Claude Code and Spotlight

## Features

- 🌐 Automatic Caddy route setup with subdomain or root domain support
- 🗄️ PostgreSQL database creation from templates
- 🔢 Deterministic port allocation based on worktree path
- 📝 Automatic .env file updates across all packages
- 🔄 Database backup and restore functionality
- 🔍 Spotlight integration for debugging
- 🤖 MCP (Model Context Protocol) configuration
- 🏥 Built-in health checks and diagnostics

## Installation

### Local Development

```bash
# Install dependencies
pnpm install

# Build the package
pnpm build

# Link globally for local testing
npm link
```

### From npm (once published)

```bash
npm install -g devctl
# or
pnpm add -g devctl
```

## Quick Start

1. **Initialize configuration in your project:**

```bash
cd /path/to/your/project
devctl init my-project
```

2. **Edit `.devctlrc.json` to match your project structure**

3. **Setup a worktree:**

```bash
cd /path/to/your/worktree
devctl setup
```

## Configuration

Create a `.devctlrc.json` file in your project root. You can use `devctl init [project-name]` to generate a starter config.

### Example Configuration

```json
{
  "projectName": "my-project",
  "baseDomain": "dev.local",
  "databasePrefix": "myproject",
  "caddyApi": "http://localhost:2019",
  "portRanges": {
    "api": {
      "start": 3000,
      "count": 1000
    },
    "web": {
      "start": 5000,
      "count": 1000
    },
    "spotlight": {
      "start": 7000,
      "count": 1000
    }
  },
  "envFiles": {
    "api": "packages/api/.env",
    "web": "packages/web/.env",
    "spotlight": "packages/spotlight/.env",
    "e2e": "packages/e2e/.env"
  },
  "database": {
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "",
    "templateDb": "myproject_dev"
  },
  "features": {
    "database": true,
    "spotlight": true,
    "queuePrefix": true
  },
  "integrations": {
    "mcp": true,
    "spotlight": true
  }
}
```

### Configuration Options

#### Core Settings

- `projectName` (required): Your project name, used in various identifiers
- `baseDomain` (required): Base domain for routing (e.g., `dev.local`)
- `databasePrefix` (required): Prefix for database names
- `caddyApi`: URL for Caddy Admin API (default: `http://localhost:2019`)

#### Port Ranges

Define port ranges for each service. Ports are deterministically allocated based on worktree path:

```json
"portRanges": {
  "api": { "start": 3000, "count": 1000 },
  "web": { "start": 5000, "count": 1000 },
  "spotlight": { "start": 7000, "count": 1000 }
}
```

#### Environment Files

Specify paths to .env files relative to project root:

```json
"envFiles": {
  "api": "packages/api/.env",
  "web": "packages/web/.env",
  "spotlight": "packages/spotlight/.env",
  "e2e": "packages/e2e/.env"
}
```

#### Database Configuration

```json
"database": {
  "host": "localhost",
  "port": 5432,
  "user": "postgres",
  "password": "",
  "templateDb": "myproject_dev"
}
```

- `templateDb`: Template database to clone for new worktrees

#### Features

Enable or disable features:

```json
"features": {
  "database": true,      // PostgreSQL database per worktree
  "spotlight": true,     // Spotlight debugging integration
  "queuePrefix": true    // BullMQ queue prefix per worktree
}
```

#### Integrations

```json
"integrations": {
  "mcp": true,          // MCP configuration updates
  "spotlight": true     // Spotlight MCP server
}
```

## Commands

### `devctl setup [name]`

Setup a worktree with ports, database, and Caddy routes.

```bash
# Use current branch name
devctl setup

# Use custom subdomain
devctl setup my-feature

# Use root domain instead of subdomain
devctl setup --root-domain

# Use custom config file
devctl setup -c /path/to/.devctlrc.json
```

**What it does:**
1. Generates unique ports based on worktree path
2. Creates a PostgreSQL database from template (if enabled)
3. Updates .env files with ports and database URL
4. Configures Caddy reverse proxy routes
5. Updates .mcp.json for Claude Code integration
6. Runs database migrations

### `devctl list` / `devctl ls`

List all active Caddy routes with their ports and worktree paths.

```bash
devctl list
```

### `devctl remove <subdomain>` / `devctl rm <subdomain>`

Remove a Caddy route for a specific subdomain.

```bash
devctl remove my-feature
```

### `devctl ports <subdomain>`

Get port information for a specific subdomain.

```bash
devctl ports my-feature
```

### `devctl init [project-name]`

Create a `.devctlrc.json` configuration file in the current directory.

```bash
devctl init my-project

# Overwrite existing config
devctl init my-project --force
```

### Database Commands

#### `devctl dump [database-name]`

Dump a database to SQL file.

```bash
# Dump current worktree's database
devctl dump

# Dump specific database
devctl dump myproject_feature_branch

# Specify output file
devctl dump -o /path/to/backup.sql
```

#### `devctl restore <dump-file> [database-name]`

Restore a database from SQL dump file.

```bash
# Restore to current worktree's database
devctl restore backup.sql

# Restore to specific database
devctl restore backup.sql myproject_feature_branch
```

#### `devctl list-dumps`

List available database dump files.

```bash
devctl list-dumps
```

### `devctl doctor`

Check environment and dependencies.

```bash
devctl doctor
```

Checks:
- Configuration file
- Git repository status
- Caddy availability
- PostgreSQL tools

## Workflow Example

### Setting up a new feature branch

```bash
# Create a new worktree
git worktree add ../my-feature feature/my-feature
cd ../my-feature

# Setup development environment
devctl setup

# Start your services
pnpm dev
```

Your feature branch is now accessible at `https://my-feature.dev.local` with:
- Isolated PostgreSQL database
- Unique ports that don't conflict
- Caddy routing configured
- All .env files updated

### Working with databases

```bash
# Dump your main database for use in feature branches
cd /path/to/main-worktree
devctl dump

# In your feature worktree, restore from main
cd /path/to/feature-worktree
devctl restore myproject_main-2024-01-15T10-30-00.sql
```

### Cleaning up

```bash
# Remove Caddy route when done
devctl remove my-feature

# Remove worktree
git worktree remove ../my-feature

# Optionally drop the database
dropdb myproject_my_feature
```

## Requirements

- **Node.js**: v18 or higher
- **Caddy**: v2 with Admin API enabled
- **PostgreSQL**: For database features (optional)
- **Git**: For worktree detection

### Caddy Setup

Your Caddyfile should enable the Admin API:

```caddyfile
{
  admin localhost:2019
}
```

Or run Caddy with API enabled:

```bash
caddy run --config Caddyfile
```

### PostgreSQL Setup

For database features, ensure PostgreSQL is installed:

```bash
# macOS
brew install postgresql

# Or use Docker
docker run -d \
  --name postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

## How It Works

### Port Allocation

Ports are deterministically generated using MD5 hashing of the worktree path:

1. Hash the worktree absolute path
2. Convert first 4 hex characters to offset
3. Add offset to configured port range start
4. Check availability and try next offset if occupied

This ensures:
- Same worktree always gets same ports (if available)
- Different worktrees get different ports
- No manual port management needed

### Database Isolation

Each worktree gets its own PostgreSQL database:

1. Creates database name: `{prefix}_{sanitized_branch_name}`
2. Clones from template database using `CREATE DATABASE ... TEMPLATE`
3. Runs migrations automatically
4. Updates all .env files with new DATABASE_URL

### Caddy Routing

Automatically configures reverse proxy routes:

```
https://feature-branch.dev.local/api/*  → localhost:3042 (API)
https://feature-branch.dev.local/*      → localhost:5042 (Web)
https://feature-branch.dev.local/_spotlight → localhost:7042 (Spotlight)
```

Routes include custom headers with worktree metadata for debugging.

## Troubleshooting

### Caddy is not running

```bash
# Check if Caddy is running
curl http://localhost:2019/config/

# Start Caddy
caddy run --config Caddyfile
```

### PostgreSQL tools not found

```bash
# macOS - Install PostgreSQL
brew install postgresql

# Or use the bundled tools from Postgres.app
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
```

### Port conflicts

If ports are already in use, devctl will try up to 100 different offsets. If all fail:

1. Check what's using the ports: `lsof -i :PORT`
2. Adjust your port ranges in `.devctlrc.json`
3. Kill conflicting processes

### Database connection errors

```bash
# Check PostgreSQL is running
psql -U postgres -h localhost -d postgres

# Verify template database exists
psql -U postgres -h localhost -d postgres -c "\l"
```

### Routes not working

```bash
# Check Caddy configuration
curl http://localhost:2019/config/apps/http/servers/srv0/routes | jq

# List all routes
devctl list

# Run diagnostics
devctl doctor
```

## Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Watch mode for development
pnpm build --watch

# Link for local testing
npm link

# Test in a project
cd /path/to/test/project
devctl setup
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
