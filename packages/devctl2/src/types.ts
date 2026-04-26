export interface ProxyRoute {
  path: string;       // e.g. "/cdn/*"
  upstream: string;    // e.g. "assurixdev.blob.core.windows.net"
  pathRewrite?: { find: string; replace: string };
}

export interface DevCtl2Config {
  projectName: string;
  baseDomain: string;
  databasePrefix: string;
  portRanges: {
    [key: string]: PortRange;
  };
  apps: {
    [appName: string]: AppConfig;
  };
  database: DatabaseConfig;
  caddyApi: string;
  features: {
    database: boolean;
    caddy: boolean;
    queuePrefix: boolean;
  };
  proxyRoutes?: ProxyRoute[];
  hooks?: {
    preSetup?: string[];
    postSetup?: string[];
  };
  /**
   * When true (default), .env files from the main worktree are symlinked instead of copied.
   * This means secret rotations in the main worktree propagate immediately to all worktrees.
   * Worktree-specific values (ports, DATABASE_URL, etc.) are still patched in after symlinking.
   * Set to false to always copy (legacy behaviour).
   * Default: true
   */
  symlinkEnv?: boolean;
}

export interface AppConfig {
  envFile: string;
  portVar?: string;
  extraVars?: {
    [key: string]: string;
  };
  /**
   * Custom hostname pattern for this app's Caddy route.
   * Supports template variables: {branch}, {baseDomain}
   * Example: "{branch}-admin.{baseDomain}" creates "feature-auth-admin.mailhooks.localhost"
   * If not set, app shares the default route (api+web pattern)
   */
  hostname?: string;
}

export interface PortRange {
  start: number;
  count: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  templateDb: string | null;
}

export interface AllocatedPorts {
  [appName: string]: number;
}

export interface DatabaseInfo {
  created: boolean;
  dbName: string;
  usingRootDomain?: boolean;
}

export interface CaddyRoute {
  '@id': string;
  match: Array<{ host: string[] }>;
  handle: any[];
  terminal: boolean;
}

export interface RouteInfo {
  url: string;
  host: string;
  apiPort: string;
  webPort: string;
  path: string;
  id: string;
}

export interface PostgresTools {
  psql: string | string[];
  createdb: string | string[];
  dropdb: string | string[];
  pg_dump: string | string[];
  pg_restore: string | string[];
  type: 'native' | 'docker';
  container?: string;
}

export interface ConfigResult {
  config: DevCtl2Config;
  configPath: string | null;
  isEmpty: boolean;
}

export interface TemplateContext {
  branch: string;
  baseDomain: string;
  queuePrefix: string;
  databaseUrl: string;
  ports: AllocatedPorts;
}
