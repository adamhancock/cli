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
  hooks?: {
    preSetup?: string[];
    postSetup?: string[];
  };
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
