export interface LoopbackConfig {
  /**
   * Enable unique loopback IP allocation per worktree.
   * Each worktree gets its own 127.0.0.x address so all services
   * can use standard ports (3001, 5173, etc.) without collisions.
   * When enabled, portRanges become optional — standard ports are used
   * on unique IPs instead of unique ports on 127.0.0.1.
   */
  enabled: boolean;
  /**
   * Start of the loopback IP range (default: 2, i.e. 127.0.0.2).
   * 127.0.0.1 is reserved for the main worktree.
   * Max usable: 250 (127.0.0.250).
   */
  start?: number;
}

export interface ProxyRoute {
  path: string;
  upstream: string;
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
  /** When true, .env files from the main worktree are copied instead of symlinked. */
  preferEnvCopyOverSymlink?: boolean;
  /**
   * Loopback IP allocation per worktree.
   * Each non-main worktree gets a unique 127.0.0.x address.
   * This eliminates port conflicts — all services use standard ports
   * (3001, 5173, etc.) on their own loopback IP.
   */
  loopback?: LoopbackConfig;
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
  psql: string | string[] | string[][];
  createdb: string | string[] | string[][];
  dropdb: string | string[] | string[][];
  pg_dump: string | string[] | string[][];
  pg_restore: string | string[] | string[][];
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
  /** When loopback is enabled, the unique 127.0.0.x IP for this worktree */
  loopbackHost?: string;
}