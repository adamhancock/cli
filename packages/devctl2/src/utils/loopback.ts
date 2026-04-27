import crypto from 'crypto';
import os from 'os';
import { $ } from 'zx';
import type { LoopbackConfig } from '../types.js';

$.verbose = false;

const DEFAULT_LOOPBACK: Required<LoopbackConfig> = {
  base: '127.0.0.0',
  prefixLength: 8,
  exclude: ['127.0.0.1']
};

function resolveLoopback(config?: LoopbackConfig): Required<LoopbackConfig> {
  return {
    base: config?.base ?? DEFAULT_LOOPBACK.base,
    prefixLength: config?.prefixLength ?? DEFAULT_LOOPBACK.prefixLength,
    exclude: config?.exclude ?? DEFAULT_LOOPBACK.exclude
  };
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(value: number): string {
  const v = value >>> 0;
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/**
 * Deterministically derive a loopback address from a worktree path.
 * Hashes the path and maps it into the configured subnet, skipping the
 * network/broadcast addresses and any explicitly excluded entries.
 */
export function generateLoopbackAddress(workdir: string, config?: LoopbackConfig): string {
  const settings = resolveLoopback(config);
  const baseInt = ipToInt(settings.base);
  const hostBits = 32 - settings.prefixLength;
  const mask = hostBits === 32 ? 0xffffffff : ((1 << hostBits) >>> 0) - 1;
  const networkBase = (baseInt & ~mask) >>> 0;
  const excluded = new Set(settings.exclude);

  const hash = crypto.createHash('sha256').update(workdir).digest();
  const seed = hash.readUInt32BE(0);

  const maxAttempts = Math.min(mask, 4096);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offset = ((seed + attempt) >>> 0) & mask;
    // Skip network address and broadcast address
    if (offset === 0 || offset === mask) continue;

    const addr = intToIp(networkBase | offset);
    if (excluded.has(addr)) continue;
    return addr;
  }

  throw new Error('Could not allocate a loopback address from the configured range');
}

/**
 * Returns true if the given loopback address is reachable as a local interface.
 * On Linux this is always true for 127.0.0.0/8 thanks to the kernel route.
 * On macOS additional addresses must be explicitly aliased on lo0.
 */
export async function isLoopbackAvailable(address: string): Promise<boolean> {
  if (address === '127.0.0.1') return true;
  if (process.platform !== 'darwin') return true;

  try {
    const { stdout } = await $`ifconfig lo0`.quiet();
    return stdout.includes(`inet ${address} `) || stdout.endsWith(`inet ${address}`);
  } catch {
    return false;
  }
}

/**
 * Add a loopback alias on the local machine. No-op on Linux.
 * Returns true if an alias was added or already existed, false if it could not be added.
 */
export async function addLoopbackAlias(address: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (await isLoopbackAvailable(address)) return true;

  try {
    await $`sudo ifconfig lo0 alias ${address} up`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a loopback alias from the local machine. No-op on Linux.
 */
export async function removeLoopbackAlias(address: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (address === '127.0.0.1') return false;

  try {
    await $`sudo ifconfig lo0 -alias ${address}`;
    return true;
  } catch {
    return false;
  }
}

/**
 * List loopback aliases currently configured on lo0 (macOS) or lo (Linux).
 */
export async function listLoopbackAliases(): Promise<string[]> {
  const iface = process.platform === 'darwin' ? 'lo0' : 'lo';
  try {
    const { stdout } = await $`ifconfig ${iface}`.quiet();
    const matches = stdout.match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/g) || [];
    return matches.map(m => m.replace(/^inet\s+/, ''));
  } catch {
    // Fallback to os.networkInterfaces() if ifconfig is unavailable
    const ifaces = os.networkInterfaces();
    const lo = ifaces[iface] || ifaces['lo'] || [];
    return lo.filter(i => i.family === 'IPv4').map(i => i.address);
  }
}
