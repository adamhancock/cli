import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const execAsync = promisify(exec);

export interface ClaudeSession {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  isWorking: boolean;
  lastActivityTime?: Date;
}

/**
 * Check if a Claude process is actively working by checking CPU usage
 */
async function isProcessWorking(pid: number): Promise<boolean> {
  try {
    // Get CPU usage for the process
    const { stdout } = await execAsync(`/bin/ps -p ${pid} -o %cpu= 2>/dev/null || true`);
    const cpuUsage = parseFloat(stdout.trim());

    // If CPU usage is > 5%, consider it actively working
    return cpuUsage > 5.0;
  } catch {
    return false;
  }
}

/**
 * Get all active Claude Code sessions by checking process CWDs
 * This is more reliable than lock files which may be stale
 */
async function getClaudeProcesses(): Promise<Map<string, ClaudeSession>> {
  const sessions = new Map<string, ClaudeSession>();

  try {
    // Get all claude process PIDs
    const { stdout: psOutput } = await execAsync(
      'ps aux | grep -E "^\\S+\\s+\\d+.*claude\\s*$" | awk \'{print $2}\''
    );

    const pids = psOutput.trim().split('\n').filter(Boolean);

    // For each PID, check its CWD and activity using lsof
    for (const pidStr of pids) {
      try {
        const pid = parseInt(pidStr, 10);
        const { stdout: lsofOutput } = await execAsync(`/usr/sbin/lsof -p ${pidStr} 2>/dev/null || true`);

        // Find the cwd line
        const cwdLine = lsofOutput.split('\n').find((line) => line.includes(' cwd '));
        if (cwdLine) {
          // Extract the directory path (last column)
          const parts = cwdLine.trim().split(/\s+/);
          const cwd = parts[parts.length - 1];

          // Check if process is actively working
          const isWorking = await isProcessWorking(pid);

          const session: ClaudeSession = {
            pid,
            workspaceFolders: [cwd],
            ideName: 'Claude Code',
            isWorking,
          };

          sessions.set(cwd, session);
        }
      } catch {
        // Skip processes we can't read
      }
    }
  } catch {
    // Failed to get processes
  }

  return sessions;
}

/**
 * Get active Claude Code sessions from lock files
 * Lock files may be stale, so this is used as a secondary source
 */
async function getClaudeSessionsFromLockFiles(): Promise<Map<string, ClaudeSession>> {
  const sessions = new Map<string, ClaudeSession>();

  try {
    const claudeIdePath = join(homedir(), '.claude', 'ide');
    const files = await readdir(claudeIdePath);
    const lockFiles = files.filter((f) => f.endsWith('.lock'));

    for (const lockFile of lockFiles) {
      try {
        const pidStr = lockFile.replace('.lock', '');
        const pid = parseInt(pidStr, 10);

        // Check if process is still running
        const { stdout: psOutput } = await execAsync(`/bin/ps -p ${pid} 2>/dev/null || true`);
        if (!psOutput.trim()) {
          continue; // Process not running
        }

        // Read lock file
        const lockPath = join(claudeIdePath, lockFile);
        const content = await readFile(lockPath, 'utf-8');
        const lockData = JSON.parse(content);

        // Get lock file modification time for activity detection
        const lockStats = await stat(lockPath);
        const lastModified = lockStats.mtime;
        const ageInSeconds = (Date.now() - lastModified.getTime()) / 1000;

        // Check if process is actively working
        const isWorking = await isProcessWorking(pid);

        if (lockData.workspaceFolders && Array.isArray(lockData.workspaceFolders)) {
          const session: ClaudeSession = {
            pid,
            workspaceFolders: lockData.workspaceFolders,
            ideName: lockData.ideName || 'Unknown',
            isWorking,
            lastActivityTime: lastModified,
          };

          // Map each workspace folder to this session
          for (const folder of lockData.workspaceFolders) {
            sessions.set(folder, session);
          }
        }
      } catch {
        // Skip invalid lock files
      }
    }
  } catch {
    // .claude/ide directory doesn't exist or can't be read
  }

  return sessions;
}

/**
 * Get all active Claude Code sessions
 * Returns a map of workspace folder path to Claude session info
 * Combines data from both process inspection and lock files
 */
export async function getClaudeCodeSessions(): Promise<Map<string, ClaudeSession>> {
  // Get sessions from both sources
  const [processSessions, lockFileSessions] = await Promise.all([
    getClaudeProcesses(),
    getClaudeSessionsFromLockFiles(),
  ]);

  // Merge them, preferring process-based detection (more reliable)
  const sessions = new Map([...lockFileSessions, ...processSessions]);

  return sessions;
}

/**
 * Check if Claude Code is active in a specific directory
 */
export async function isClaudeCodeActive(repoPath: string): Promise<ClaudeSession | null> {
  const sessions = await getClaudeCodeSessions();
  return sessions.get(repoPath) || null;
}
