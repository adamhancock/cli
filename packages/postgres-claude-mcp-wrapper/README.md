# Postgres Claude MCP Wrapper

A simple CLI tool to configure PostgreSQL Model Context Protocol (MCP) server for Claude Desktop using environment variables.

## Installation

```bash
# Install globally
npm install -g @adamhancock/postgres-claude-mcp-wrapper

# Or use with npx
npx @adamhancock/postgres-claude-mcp-wrapper

# Or install locally
pnpm add @adamhancock/postgres-claude-mcp-wrapper
```

## Setup

1. Create a `.env` file in your project root:

```bash
cp .env.example .env
```

2. Edit `.env` with your PostgreSQL connection string:

```env
DATABASE_URL=postgresql://username:password@host:port/database
```

## Usage

### Using the CLI command (if installed)
```bash
postgres-mcp-setup
```

### Using npm scripts
```bash
pnpm run setup
```

### Using tsx directly
```bash
tsx setup-mcp.ts
```

## What it does

This tool automatically configures the Claude Desktop app to connect to your PostgreSQL database by:

1. Reading your `DATABASE_URL` from the `.env` file
2. Running `claude mcp add-json` with the proper configuration
3. Setting up the MCP server to use `@modelcontextprotocol/server-postgres`

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (required)

## Example

```bash
# With a local PostgreSQL database
DATABASE_URL=postgresql://dev_user:dev_password@127.0.0.1:5432/my_database

# With a remote database
DATABASE_URL=postgresql://user:pass@db.example.com:5432/production_db
```

## Security

The tool masks passwords when displaying connection information in the console output for security.

## Requirements

- Node.js 18+
- Claude Code
- PostgreSQL database accessible from your machine

## License

ISC