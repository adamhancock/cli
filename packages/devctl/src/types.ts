export interface DevCtlConfig {
  projectName: string;
  baseDomain: string;
  databasePrefix: string;
  portRanges: {
    api: PortRange;
    web: PortRange;
    spotlight: PortRange;
    [key: string]: PortRange;
  };
  envFiles: {
    [key: string]: string;
  };
  envVariables: {
    [key: string]: string[];
  };
  database: DatabaseConfig;
  integrations: {
    spotlight: boolean;
    mcp: boolean;
  };
  caddyApi: string;
  features: {
    database: boolean;
    envFiles: boolean;
    queuePrefix: boolean;
    spotlight: boolean;
    mcp: boolean;
  };
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

export interface Ports {
  api: number;
  web: number;
  spotlight?: number | null;
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
  config: DevCtlConfig;
  configPath: string | null;
  isEmpty: boolean;
}
