import crypto from 'crypto';
import { $ } from 'zx';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { DevCtl2Config, AllocatedPorts, AppConfig } from '../types.js';

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
 * Read existing port from an app's .env file
 */
async function getExistingPortForApp(
  appConfig: AppConfig,
  workdir: string
): Promise<number | null> {
  if (!appConfig.portVar) return null;

  const envPath = path.join(workdir, appConfig.envFile);
  if (!existsSync(envPath)) return null;

  try {
    const envContent = await readFile(envPath, 'utf8');
    const regex = new RegExp(`^${appConfig.portVar}=(\\d+)$`, 'm');
    const match = envContent.match(regex);
    if (match) {
      return parseInt(match[1]);
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Read existing ports from all app .env files
 */
export async function getExistingPorts(
  config: DevCtl2Config,
  workdir: string
): Promise<AllocatedPorts | null> {
  const ports: AllocatedPorts = {};
  let foundAny = false;

  for (const [appName, appConfig] of Object.entries(config.apps)) {
    // Only check apps that have portVar (they get allocated ports)
    if (!appConfig.portVar || !config.portRanges[appName]) continue;

    const port = await getExistingPortForApp(appConfig, workdir);
    const range = config.portRanges[appName];

    // Only accept ports that are within the valid range (but not the start)
    // This prevents reusing ports from copied .env files that aren't in our range
    if (port !== null &&
        port !== range.start &&
        port >= range.start &&
        port < range.start + range.count) {
      ports[appName] = port;
      foundAny = true;
    }
  }

  // Only return if we found at least one valid non-default port in range
  return foundAny ? ports : null;
}

/**
 * Generate unique ports based on worktree path for all apps in portRanges
 */
export async function generatePorts(
  config: DevCtl2Config,
  workdir: string
): Promise<AllocatedPorts> {
  // First check if there are existing ports in .env files that aren't defaults
  const existingPorts = await getExistingPorts(config, workdir);
  if (existingPorts && Object.keys(existingPorts).length > 0) {
    console.log('   Using existing ports from .env files');

    // Fill in any missing ports
    const allPorts = { ...existingPorts };
    for (const [appName, range] of Object.entries(config.portRanges)) {
      if (allPorts[appName] === undefined) {
        allPorts[appName] = range.start;
      }
    }
    return allPorts;
  }

  // Generate hash from workdir for consistent port allocation
  const hash = crypto.createHash('md5').update(workdir).digest('hex');

  // Get all apps that need ports
  const appsNeedingPorts = Object.keys(config.portRanges);

  // Get the minimum count across all port ranges
  const minCount = Math.min(
    ...Object.values(config.portRanges).map(r => r.count)
  );

  let offset = parseInt(hash.slice(0, 4), 16) % minCount;

  // Try to find available ports, checking up to 100 offsets
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidatePorts: AllocatedPorts = {};
    let allAvailable = true;

    // Calculate ports for all apps
    for (const appName of appsNeedingPorts) {
      const range = config.portRanges[appName];
      const port = range.start + (offset % range.count);
      candidatePorts[appName] = port;

      const available = await isPortAvailable(port);
      if (!available) {
        allAvailable = false;
        break;
      }
    }

    if (allAvailable) {
      return candidatePorts;
    }

    // Try next offset
    offset = (offset + 1) % minCount;
  }

  // Fallback to default ports if no available ports found
  console.warn('Warning: Could not find available ports, using default ports which may conflict');
  const fallbackPorts: AllocatedPorts = {};
  for (const [appName, range] of Object.entries(config.portRanges)) {
    fallbackPorts[appName] = range.start;
  }
  return fallbackPorts;
}

/**
 * Format ports for display
 */
export function formatPorts(ports: AllocatedPorts): Record<string, number> {
  return { ...ports };
}
