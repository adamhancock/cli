import { cosmiconfig } from 'cosmiconfig';
import type { DevCtlConfig } from './types.js';

// Default configuration
const defaultConfig: DevCtlConfig = {
  projectName: 'myapp',
  baseDomain: 'localhost',
  databasePrefix: 'myapp',
  portRanges: {
    api: { start: 3001, count: 100 },
    web: { start: 5173, count: 100 },
    spotlight: { start: 8970, count: 100 }
  },
  envFiles: {
    api: 'apps/api/.env',
    web: 'apps/web/.env',
    e2e: 'apps/e2e/.env',
    spotlight: 'tools/spotlight/.env'
  },
  envVariables: {
    api: ['PORT', 'FRONTEND_URL', 'BULLMQ_QUEUE_PREFIX', 'SPOTLIGHT_PORT', 'DATABASE_URL'],
    web: ['VITE_API_PORT', 'VITE_PORT'],
    e2e: ['BASE_URL'],
    spotlight: ['SPOTLIGHT_PORT']
  },
  database: {
    host: 'localhost',
    port: 5432,
    user: 'dev_user',
    password: 'dev_password',
    templateDb: null
  },
  integrations: {
    spotlight: false,
    mcp: false
  },
  caddyApi: 'http://localhost:2019',
  features: {
    database: true,
    envFiles: true,
    queuePrefix: true,
    spotlight: false,
    mcp: false
  }
};

export interface ConfigResult {
  config: DevCtlConfig;
  configPath: string | null;
  isEmpty: boolean;
}

/**
 * Load configuration from various sources
 */
export async function loadConfig(searchFrom: string = process.cwd()): Promise<ConfigResult> {
  const explorer = cosmiconfig('devctl', {
    searchPlaces: [
      '.devctlrc.json',
      '.devctlrc.js',
      '.devctlrc.yaml',
      '.devctlrc.yml',
      'devctl.config.js',
      'devctl.config.json'
    ]
  });

  try {
    const result = await explorer.search(searchFrom);

    if (result) {
      const config = mergeConfig(defaultConfig, result.config);

      // Set template DB default if not specified
      if (!config.database.templateDb) {
        config.database.templateDb = `${config.databasePrefix}_dev`;
      }

      return {
        config,
        configPath: result.filepath,
        isEmpty: result.isEmpty || false
      };
    }

    // No config found, return defaults
    const config = { ...defaultConfig };
    if (!config.database.templateDb) {
      config.database.templateDb = `${config.databasePrefix}_dev`;
    }

    return {
      config,
      configPath: null,
      isEmpty: true
    };
  } catch (error) {
    throw new Error(`Failed to load config: ${(error as Error).message}`);
  }
}

/**
 * Deep merge configuration objects
 */
function mergeConfig(defaults: DevCtlConfig, userConfig: Partial<DevCtlConfig>): DevCtlConfig {
  const merged = { ...defaults };

  for (const key in userConfig) {
    const value = userConfig[key as keyof DevCtlConfig];
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      (merged as any)[key] = {
        ...(defaults as any)[key],
        ...value
      };
    } else {
      (merged as any)[key] = value;
    }
  }

  return merged;
}

/**
 * Validate configuration
 */
export function validateConfig(config: DevCtlConfig): boolean {
  const errors: string[] = [];

  // Required fields
  if (!config.projectName) {
    errors.push('projectName is required');
  }

  if (!config.baseDomain) {
    errors.push('baseDomain is required');
  }

  if (!config.caddyApi) {
    errors.push('caddyApi is required');
  }

  // Port ranges validation
  if (config.portRanges) {
    for (const [service, range] of Object.entries(config.portRanges)) {
      if (!range.start || !range.count) {
        errors.push(`portRanges.${service} must have 'start' and 'count' properties`);
      }
      if (range.start < 1024 || range.start > 65535) {
        errors.push(`portRanges.${service}.start must be between 1024 and 65535`);
      }
    }
  }

  // Database validation
  if (config.features.database && config.database) {
    if (!config.database.host) {
      errors.push('database.host is required when database feature is enabled');
    }
    if (!config.database.user) {
      errors.push('database.user is required when database feature is enabled');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

/**
 * Get default configuration object
 */
export function getDefaultConfig(): DevCtlConfig {
  return JSON.parse(JSON.stringify(defaultConfig));
}

/**
 * Create example configuration file content
 */
export function createExampleConfig(projectName: string = 'myapp'): string {
  const config = getDefaultConfig();
  config.projectName = projectName;
  config.databasePrefix = projectName;

  return JSON.stringify(config, null, 2);
}
