import type { WorkstreamPluginConfig } from './types.ts';

export const DEFAULT_CONFIG: WorkstreamPluginConfig = {
  redis: {
    host: 'localhost',
    port: 6379,
  },
  
  features: {
    eventTracking: true,
    customTools: true,
    contextInjection: true,
    safetyGuards: true,
    analytics: true,
    notifications: true,
    biDirectionalControl: true,
  },
  
  analytics: {
    costThreshold: 5.0, // $5 USD
    timeThreshold: 30, // 30 minutes
    errorThreshold: 10, // 10 errors
  },
  
  safety: {
    protectedBranches: ['main', 'master', 'production', 'prod'],
    requireCleanBranch: false,
    confirmDestructiveCommands: [
      'rm -rf',
      'sudo rm',
      'drop table',
      'drop database',
      'truncate table',
      'git reset --hard',
      'git clean -fd',
    ],
    maxConcurrentSessions: 3,
  },
  
  notifications: {
    onSessionIdle: true,
    onError: true,
    onCostThreshold: true,
    onPRCheckComplete: true,
  },
};

/**
 * Load user configuration from .opencode/workstream-config.json
 * Falls back to default config if file doesn't exist
 */
export async function loadConfig(directory: string): Promise<WorkstreamPluginConfig> {
  try {
    const configPath = `${directory}/.opencode/workstream-config.json`;
    const fs = await import('fs/promises');
    const configFile = await fs.readFile(configPath, 'utf-8');
    const userConfig = JSON.parse(configFile) as Partial<WorkstreamPluginConfig>;
    
    // Deep merge with defaults
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      redis: { ...DEFAULT_CONFIG.redis, ...userConfig.redis },
      features: { ...DEFAULT_CONFIG.features, ...userConfig.features },
      analytics: { ...DEFAULT_CONFIG.analytics, ...userConfig.analytics },
      safety: { ...DEFAULT_CONFIG.safety, ...userConfig.safety },
      notifications: { ...DEFAULT_CONFIG.notifications, ...userConfig.notifications },
    };
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}
