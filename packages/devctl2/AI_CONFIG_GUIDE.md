# AI Guide: Creating devctl2 Configuration

This guide helps AI assistants automatically generate `.devctl2rc.json` configuration files for projects.

## Quick Start

When asked to set up devctl2 for a project, analyze the codebase and generate a `.devctl2rc.json` file in the project root.

## Configuration Schema

```typescript
interface DevCtl2Config {
  projectName: string;           // Project identifier (e.g., "myapp")
  baseDomain: string;            // Base domain for routing (e.g., "myapp.localhost")
  databasePrefix: string;        // Prefix for database names (e.g., "myapp")
  caddyApi: string;              // Caddy Admin API URL (default: "http://localhost:2019")
  portRanges: Record<string, { start: number; count: number }>;
  apps: Record<string, AppConfig>;
  database: DatabaseConfig;
  features: {
    database: boolean;           // Enable PostgreSQL per worktree
    caddy: boolean;              // Enable Caddy routing
    queuePrefix: boolean;        // Enable BullMQ queue isolation
  };
  hooks?: {
    preSetup?: string[];         // Commands to run before setup
    postSetup?: string[];        // Commands to run after setup
  };
}

interface AppConfig {
  envFile: string;               // Path to .env file relative to project root
  portVar?: string;              // Env var name for port (e.g., "PORT", "VITE_PORT")
  hostname?: string;             // Custom hostname pattern (e.g., "{branch}-admin.{baseDomain}")
  extraVars?: Record<string, string>;  // Additional env vars with template support
}

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  templateDb: string | null;     // Database to clone for new worktrees
}
```

## Template Variables

Use these in `extraVars` values:

| Variable | Description | Example Output |
|----------|-------------|----------------|
| `{branch}` | Current git branch/worktree name | `feature-auth` |
| `{baseDomain}` | From config | `myapp.localhost` |
| `{queuePrefix}` | Queue prefix for BullMQ isolation | `myapp_feature_auth` |
| `{databaseUrl}` | Full PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `{ports.api}` | Allocated port for "api" app | `3042` |
| `{ports.web}` | Allocated port for "web" app | `5042` |
| `{ports.<name>}` | Allocated port for any app | (varies) |

## How to Analyze a Project

### 1. Identify Project Structure

Look for these patterns:

```bash
# Monorepo with apps/
apps/
  api/           # Backend - needs PORT
  web/           # Frontend - needs VITE_PORT or similar
  admin/         # Admin panel - separate hostname?
  e2e/           # E2E tests - needs BASE_URL

# Monorepo with packages/
packages/
  api/
  web/
  db/            # Shared database package

# Single app
src/
package.json
```

### 2. Find .env Files

Search for existing `.env` or `.env.example` files:

```bash
find . -name ".env*" -not -path "*/node_modules/*"
```

Examine them to understand what environment variables each app needs.

### 3. Identify Port Variables

Common patterns:

| Framework | Port Variable | Default |
|-----------|--------------|---------|
| Express/NestJS | `PORT` | 3000 |
| Vite | `VITE_PORT` or just uses config | 5173 |
| Next.js | `PORT` | 3000 |
| Remix | `PORT` | 3000 |
| Create React App | `PORT` | 3000 |

### 4. Check for Database Usage

Look for:
- `prisma/schema.prisma` - Uses Prisma ORM
- `DATABASE_URL` in .env files
- `packages/db/` - Shared database package
- `drizzle.config.ts` - Uses Drizzle ORM

### 5. Check for Queue Usage

Look for:
- BullMQ imports - needs `BULLMQ_QUEUE_PREFIX`
- Redis configuration

### 6. Check for Multiple Hostnames

If an app needs a separate subdomain (like an admin panel), use the `hostname` field:

```json
"admin": {
  "envFile": "apps/admin/.env",
  "portVar": "VITE_PORT",
  "hostname": "{branch}-admin.{baseDomain}"
}
```

## Example: Analyzing mailhooks Project

### Project Structure Found:
```
apps/
  api/         # NestJS backend
  web/         # TanStack Start frontend
  admin/       # Admin panel (needs separate hostname)
  e2e/         # Playwright tests
packages/
  db/          # Prisma database package
```

### Analysis Results:
- **api**: NestJS uses `PORT`, needs `DATABASE_URL`, `FRONTEND_URL`, `BULLMQ_QUEUE_PREFIX`, `SMTP_PORT`
- **web**: Vite uses `VITE_PORT`, needs `VITE_API_PORT` to know API location
- **admin**: Vite uses `VITE_PORT`, needs separate hostname for Caddy routing
- **e2e**: No port, just needs `BASE_URL` for tests
- **db**: Just needs `DATABASE_URL` for Prisma

### Generated Config:

```json
{
  "projectName": "mailhooks",
  "baseDomain": "mailhooks.localhost",
  "databasePrefix": "mailhooks",
  "caddyApi": "http://localhost:2019",
  "portRanges": {
    "api": { "start": 3001, "count": 100 },
    "web": { "start": 5173, "count": 100 },
    "admin": { "start": 5273, "count": 100 },
    "smtp": { "start": 2525, "count": 100 }
  },
  "apps": {
    "api": {
      "envFile": "apps/api/.env",
      "portVar": "PORT",
      "extraVars": {
        "FRONTEND_URL": "https://{branch}.{baseDomain}",
        "BULLMQ_QUEUE_PREFIX": "{queuePrefix}",
        "SMTP_PORT": "{ports.smtp}"
      }
    },
    "web": {
      "envFile": "apps/web/.env",
      "portVar": "VITE_PORT",
      "extraVars": {
        "VITE_API_PORT": "{ports.api}"
      }
    },
    "admin": {
      "envFile": "apps/admin/.env",
      "portVar": "VITE_PORT",
      "hostname": "{branch}-admin.{baseDomain}",
      "extraVars": {
        "VITE_API_PORT": "{ports.api}"
      }
    },
    "e2e": {
      "envFile": "apps/e2e/.env",
      "extraVars": {
        "BASE_URL": "https://{branch}.{baseDomain}"
      }
    },
    "db": {
      "envFile": "packages/db/.env",
      "extraVars": {
        "DATABASE_URL": "{databaseUrl}"
      }
    }
  },
  "database": {
    "host": "localhost",
    "port": 5432,
    "user": "dev_user",
    "password": "dev_password",
    "templateDb": "mailhooks"
  },
  "features": {
    "database": true,
    "caddy": true,
    "queuePrefix": true
  },
  "hooks": {
    "postSetup": ["cd packages/db && npx prisma generate"]
  }
}
```

## Port Range Guidelines

| Service Type | Suggested Start | Notes |
|--------------|-----------------|-------|
| API/Backend | 3001-3999 | Avoid 3000 (common default) |
| Web/Frontend | 5173+ | Vite default is 5173 |
| Admin panels | 5273+ | Offset from web |
| SMTP | 2525 | Standard dev SMTP port |
| WebSocket | 8080+ | If separate from API |

Use `count: 100` for most apps - allows 100 worktrees per service.

## Hooks

Common post-setup hooks:

```json
"hooks": {
  "postSetup": [
    "cd packages/db && npx prisma generate",
    "pnpm install",
    "pnpm db:migrate"
  ]
}
```

## Checklist for AI

Before generating config, verify:

- [ ] Found all apps with .env files
- [ ] Identified port variables for each app
- [ ] Checked if database is used
- [ ] Checked if BullMQ/queues are used
- [ ] Identified apps needing separate hostnames
- [ ] Set appropriate port ranges (non-overlapping)
- [ ] Added necessary extraVars for cross-app communication
- [ ] Added postSetup hooks for code generation (Prisma, etc.)

## Validation

After generating, the config must pass these rules:

1. `projectName` is required
2. `baseDomain` is required
3. Each `portRanges` entry needs `start` (1024-65535) and `count`
4. Each `apps` entry needs `envFile`
5. If app has `portVar`, it needs matching `portRanges.<appName>`
6. If `features.database` is true, `database.host` and `database.user` are required
7. If `features.caddy` is true, `caddyApi` is required

## Running Setup

After creating the config file, run:

```bash
devctl2 setup
```

This will:
1. Allocate ports based on worktree path hash
2. Create database from template (if enabled)
3. Update all .env files
4. Configure Caddy routes
5. Run postSetup hooks
