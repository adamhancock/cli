import crypto from 'crypto';
import { $ } from 'zx';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';

$.verbose = false;

const DEFAULT_START = 2;
const DEFAULT_END = 255;

const isMac = os.platform() === 'darwin';

// Registry file to track which workdir owns which IP
const REGISTRY_DIR = '/tmp/devctl2-loopback';
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'allocations.json');

interface Allocation {
  ip: string;
  workdir: string;
  allocatedAt: string;
}

function loadRegistry(): Allocation[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRegistry(allocations: Allocation[]): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(allocations, null, 2));
}

/**
 * Allocate a loopback IP for a worktree.
 *
 * Uses a hash of the worktree path as a starting point, then linear probes
 * if that IP is taken by a different workdir. The full 127.x.y.z space
 * (65,025 addresses) is available, so collisions are extremely unlikely.
 *
 * A registry file (/tmp/devctl2-loopback/allocations.json) tracks which
 * workdir owns which IP, so different worktrees never get the same IP.
 *
 * @param workdir - The worktree directory path
 * @param start - Start of the last octet range (default: 2)
 * @param end - End of the last octet range (default: 255)
 * @returns The allocated IP address (e.g., "127.1.5.2")
 */
export async function allocateLoopbackIp(
  workdir: string,
  start: number = DEFAULT_START,
  end: number = DEFAULT_END
): Promise<string> {
  const allocations = loadRegistry();

  // Check if this workdir already has an allocation
  const existing = allocations.find((a) => a.workdir === workdir);
  if (existing) {
    console.log(chalk.gray(`   Loopback IP ${existing.ip} (existing allocation)`));
    return existing.ip;
  }

  // Hash the workdir to get deterministic starting points for both octets
  const hash = crypto.createHash('sha256').update(workdir).digest();

  // Use bytes from hash for the second, third, and fourth octets
  // Full 127.x.y.z space: ~16M addresses (x: 1-254, y: 0-255, z: start-end)
  const secondOctet = hash[0] % 254 + 1; // 1-254 (avoid 0 since 127.0.x.y is congested)
  const thirdOctet = hash[1]; // 0-255
  const fourthOctet = start + (hash[2] % (end - start + 1)); // start-end

  const candidateIp = `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;

  // Check if this IP is already allocated to a different workdir
  const takenIps = new Set(allocations.map((a) => a.ip));
  let ip = candidateIp;
  let probeOffset = 0;

  while (takenIps.has(ip)) {
    // Linear probe: increment fourth octet, carry to third, then second
    probeOffset++;
    const range = end - start + 1;
    const f = start + ((fourthOctet - start + probeOffset) % range);
    const carry1 = Math.floor((fourthOctet - start + probeOffset) / range);
    const t = (thirdOctet + carry1) % 256;
    const carry2 = Math.floor((thirdOctet + carry1) / 256);
    const s = ((secondOctet - 1 + carry2) % 254) + 1;
    ip = `127.${s}.${t}.${f}`;

    // Safety: extremely unlikely but prevent infinite loop
    if (probeOffset > 65000000) {
      throw new Error('Loopback IP space exhausted');
    }
  }

  // Register the allocation
  allocations.push({
    ip,
    workdir,
    allocatedAt: new Date().toISOString(),
  });
  saveRegistry(allocations);

  return ip;
}

/**
 * Release a loopback IP allocation for a workdir.
 * Removes from the registry file (does NOT remove from the interface).
 *
 * @param workdir - The worktree directory path
 */
export function releaseLoopbackIp(workdir: string): void {
  const allocations = loadRegistry();
  const filtered = allocations.filter((a) => a.workdir !== workdir);
  saveRegistry(filtered);
}

/**
 * Add a loopback IP address to the loopback interface.
 * Safe to call multiple times — silently succeeds if already assigned.
 * Works on both Linux (ip addr) and macOS (ifconfig).
 *
 * @param ip - The IP address to add (e.g., "127.1.5.2")
 */
export async function addLoopbackIp(ip: string): Promise<void> {
  try {
    if (isMac) {
      await $`sudo ifconfig lo0 alias ${ip} 255.0.0.0 2>/dev/null || true`;
    } else {
      await $`sudo ip addr add ${ip}/8 dev lo 2>/dev/null || true`;
    }
    console.log(chalk.green(`   ✅ Assigned loopback IP: ${ip}`));
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not add loopback IP ${ip}: ${(error as Error).message}`));
    if (isMac) {
      console.log(chalk.gray(`   Try: sudo ifconfig lo0 alias ${ip} 255.0.0.0`));
    } else {
      console.log(chalk.gray(`   Try: sudo ip addr add ${ip}/8 dev lo`));
    }
  }
}

/**
 * Remove a loopback IP address from the loopback interface.
 * Works on both Linux and macOS.
 *
 * @param ip - The IP address to remove (e.g., "127.1.5.2")
 */
export async function removeLoopbackIp(ip: string): Promise<void> {
  try {
    if (isMac) {
      await $`sudo ifconfig lo0 -alias ${ip} 2>/dev/null || true`;
    } else {
      await $`sudo ip addr del ${ip}/8 dev lo 2>/dev/null || true`;
    }
    console.log(chalk.green(`   ✅ Removed loopback IP: ${ip}`));
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not remove loopback IP ${ip}: ${(error as Error).message}`));
  }
}

/**
 * Get all currently assigned loopback IPs on this machine.
 * Works on both Linux and macOS.
 *
 * @returns Set of assigned IP addresses
 */
export async function getExistingLoopbackIps(): Promise<Set<string>> {
  const ips = new Set<string>();
  try {
    if (isMac) {
      const { stdout } = await $`ifconfig lo0`.quiet();
      const regex = /inet (127\.\d+\.\d+\.\d+) /g;
      let match;
      while ((match = regex.exec(stdout)) !== null) {
        ips.add(match[1]);
      }
    } else {
      const { stdout } = await $`ip addr show lo`.quiet();
      const regex = /inet (127\.\d+\.\d+\.\d+)\/8/g;
      let match;
      while ((match = regex.exec(stdout)) !== null) {
        ips.add(match[1]);
      }
    }
  } catch {
    // Silently ignore — will return empty set
  }
  return ips;
}

/**
 * Check if a loopback IP is currently assigned.
 *
 * @param ip - The IP address to check
 * @returns True if the IP is assigned to the loopback interface
 */
export async function isLoopbackIpAssigned(ip: string): Promise<boolean> {
  const existing = await getExistingLoopbackIps();
  return existing.has(ip);
}