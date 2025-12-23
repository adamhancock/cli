import { cosmiconfig } from 'cosmiconfig';
import type { DevCtl2Config, ConfigResult } from './types.js';

// Default configuration
const defaultConfig: DevCtl2Config = {
  projectName: 'myapp',
  baseDomain: 'localhost',
  databasePrefix: 'myapp',
  portRanges: {
    api: { start: 3001, count: 100 },
    web: { start: 5173, count: 100 }
  },
  apps: {
    api: {
      envFile: 'apps/api/.env',
      portVar: 'PORT',
      extraVars: {
        FRONTEND_URL: 'https://{branch}.{baseDomain}',
        DATABASE_URL: '{databaseUrl}'
      }
    },
    web: {
      envFile: 'apps/web/.env',
      portVar: 'VITE_PORT',
      extraVars: {
        VITE_API_PORT: '{ports.api}'
      }
    }
  },
  database: {
    host: 'localhost',
    port: 5432,
    user: 'dev_user',
    password: 'dev_password',
    templateDb: null
  },
  caddyApi: 'http://localhost:2019',
  features: {
    database: true,
    caddy: true,
    queuePrefix: true
  }
};

/**
 * Load configuration from various sources
 */
export async function loadConfig(searchFrom: string = process.cwd()): Promise<ConfigResult> {
  const explorer = cosmiconfig('devctl2', {
    searchPlaces: [
      '.devctl2rc.json',
      '.devctl2rc.js',
      '.devctl2rc.yaml',
      '.devctl2rc.yml',
      'devctl2.config.js',
      'devctl2.config.json'
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
function mergeConfig(defaults: DevCtl2Config, userConfig: Partial<DevCtl2Config>): DevCtl2Config {
  const merged = { ...defaults };

  for (const key in userConfig) {
    const value = userConfig[key as keyof DevCtl2Config];
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      if (key === 'apps' || key === 'portRanges') {
        // For apps and portRanges, merge each app/range individually
        (merged as any)[key] = {
          ...(defaults as any)[key],
          ...value
        };
        // Also merge nested objects for apps
        if (key === 'apps') {
          for (const appName in value as any) {
            if ((defaults as any)[key]?.[appName]) {
              (merged as any)[key][appName] = {
                ...(defaults as any)[key][appName],
                ...(value as any)[appName]
              };
            }
          }
        }
      } else {
        (merged as any)[key] = {
          ...(defaults as any)[key],
          ...value
        };
      }
    } else {
      (merged as any)[key] = value;
    }
  }

  return merged;
}

/**
 * Validate configuration
 */
export function validateConfig(config: DevCtl2Config): boolean {
  const errors: string[] = [];

  // Required fields
  if (!config.projectName) {
    errors.push('projectName is required');
  }

  if (!config.baseDomain) {
    errors.push('baseDomain is required');
  }

  if (!config.caddyApi && config.features.caddy) {
    errors.push('caddyApi is required when caddy feature is enabled');
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

  // Apps validation
  if (config.apps) {
    for (const [appName, appConfig] of Object.entries(config.apps)) {
      if (!appConfig.envFile) {
        errors.push(`apps.${appName}.envFile is required`);
      }
      // If app has a portVar, ensure there's a matching portRange
      if (appConfig.portVar && !config.portRanges[appName]) {
        errors.push(`apps.${appName} has portVar but no matching portRanges.${appName}`);
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
export function getDefaultConfig(): DevCtl2Config {
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
