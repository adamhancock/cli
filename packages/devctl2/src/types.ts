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
  /**
   * How worktrees avoid binding conflicts:
   * - 'port' (default): each worktree gets a unique port from portRanges, all bound to localhost
   * - 'loopback': each worktree gets a unique 127.x.x.x IP and uses the default ports
   */
  bindStrategy?: BindStrategy;
  loopback?: LoopbackConfig;
  proxyRoutes?: ProxyRoute[];
  hooks?: {
    preSetup?: string[];
    postSetup?: string[];
  };
}

export type BindStrategy = 'port' | 'loopback';

export interface LoopbackConfig {
  /**
   * Base address for the loopback subnet (default: '127.0.0.0').
   * Combined with `prefixLength`, defines the pool of usable addresses.
   */
  base?: string;
  /**
   * CIDR prefix length for the subnet (default: 8 — i.e., 127.0.0.0/8).
   */
  prefixLength?: number;
  /**
   * Addresses to never allocate (default: ['127.0.0.1'] so the main worktree
   * keeps localhost).
   */
  exclude?: string[];
}

export interface AppConfig {
  envFile: string;
  portVar?: string;
  /**
   * Optional name of the env var that should receive the bind host
   * (e.g. 'HOST'). When the loopback strategy is used, the worktree's
   * allocated 127.x.x.x address is written to this variable.
   */
  hostVar?: string;
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

/**
 * Result of allocating a binding (host + ports) for a worktree.
 * Under the 'port' strategy, host is always 'localhost' and ports vary per worktree.
 * Under the 'loopback' strategy, host is a unique 127.x.x.x and ports use the defaults.
 */
export interface AllocatedBinding {
  host: string;
  ports: AllocatedPorts;
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
  /**
   * Bind host for the worktree's services. Available as `{host}` in templates.
   * 'localhost' under the port strategy; a 127.x.x.x address under the loopback strategy.
   */
  host: string;
}
