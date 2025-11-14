import crypto from 'crypto';
import { $ } from 'zx';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { DevCtlConfig, Ports } from '../types.js';

$.verbose = false;

/**
 * Check if a port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    await $`lsof -i :${port}`;
    return false; // Port is in use
  } catch {
    return true; // Port is available
  }
}

/**
 * Read existing ports from .env files
 */
export async function getExistingPorts(config: DevCtlConfig, workdir: string): Promise<Ports | null> {
  try {
    let apiPort: number | null = null;
    let webPort: number | null = null;
    let spotlightPort: number | null = null;

    // Read API port and Spotlight port
    const apiEnvPath = path.join(workdir, config.envFiles.api);
    if (existsSync(apiEnvPath)) {
      const apiEnv = await readFile(apiEnvPath, 'utf8');
      const apiMatch = apiEnv.match(/^PORT=(\d+)$/m);
      if (apiMatch) {
        apiPort = parseInt(apiMatch[1]);
      }

      if (config.features.spotlight) {
        const spotlightMatch = apiEnv.match(/^SPOTLIGHT_PORT=(\d+)$/m);
        if (spotlightMatch) {
          spotlightPort = parseInt(spotlightMatch[1]);
        }
      }
    }

    // Read web port
    const webEnvPath = path.join(workdir, config.envFiles.web);
    if (existsSync(webEnvPath)) {
      const webEnv = await readFile(webEnvPath, 'utf8');
      const webPortMatch = webEnv.match(/^VITE_PORT=(\d+)$/m);
      if (webPortMatch) {
        webPort = parseInt(webPortMatch[1]);
      }
    }

    // Return ports if all required ports are found and not default ports
    const hasApi = apiPort && apiPort !== config.portRanges.api.start;
    const hasWeb = webPort && webPort !== config.portRanges.web.start;
    const hasSpotlight = !config.features.spotlight || (spotlightPort && spotlightPort !== config.portRanges.spotlight.start);

    if (hasApi && hasWeb && hasSpotlight && apiPort && webPort) {
      return { api: apiPort, web: webPort, spotlight: spotlightPort };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate unique ports based on worktree path
 */
export async function generatePorts(config: DevCtlConfig, workdir: string): Promise<Ports> {
  // First check if there are existing ports in .env files that aren't defaults
  const existingPorts = await getExistingPorts(config, workdir);
  if (existingPorts) {
    console.log('   Using existing ports from .env files');
    return existingPorts;
  }

  const hash = crypto.createHash('md5').update(workdir).digest('hex');
  let offset = parseInt(hash.slice(0, 4), 16) % config.portRanges.api.count;

  // Try to find available ports, checking up to 100 offsets
  for (let attempt = 0; attempt < 100; attempt++) {
    const apiPort = config.portRanges.api.start + offset;
    const webPort = config.portRanges.web.start + offset;
    const spotlightPort = config.features.spotlight ? config.portRanges.spotlight.start + offset : null;

    const apiAvailable = await isPortAvailable(apiPort);
    const webAvailable = await isPortAvailable(webPort);
    const spotlightAvailable = !config.features.spotlight || (spotlightPort !== null && await isPortAvailable(spotlightPort));

    if (apiAvailable && webAvailable && spotlightAvailable) {
      return {
        api: apiPort,
        web: webPort,
        spotlight: spotlightPort
      };
    }

    // Try next offset
    offset = (offset + 1) % config.portRanges.api.count;
  }

  // Fallback to original ports if no available ports found
  console.warn('Warning: Could not find available ports, using default ports which may conflict');
  return {
    api: config.portRanges.api.start,
    web: config.portRanges.web.start,
    spotlight: config.features.spotlight ? config.portRanges.spotlight.start : null
  };
}

/**
 * Format ports for display
 */
export function formatPorts(ports: Ports): Record<string, number> {
  const formatted: Record<string, number> = {
    api: ports.api,
    web: ports.web
  };

  if (ports.spotlight) {
    formatted.spotlight = ports.spotlight;
  }

  return formatted;
}
