import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Find Claude process running under a given parent PID
 * Looks for processes named "clauded", "claude-code", or "claude"
 */
export async function findClaudeProcess(parentPid: number): Promise<number | null> {
  try {
    // Use ps to get all processes with their parent PID and command
    const { stdout } = await execAsync('ps -Ao pid,ppid,comm');
    const lines = stdout.split('\n');

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const comm = parts[2];

      // Check if this process is a child of the parent PID
      // and if the command is a Claude process
      if (ppid === parentPid && /^(clauded|claude-code|claude)$/.test(comm)) {
        return pid;
      }
    }

    return null;
  } catch (error) {
    console.error('[Workstream] Error finding Claude process:', error);
    return null;
  }
}

/**
 * Find all Claude processes in the system
 */
export async function findAllClaudeProcesses(): Promise<number[]> {
  try {
    const { stdout } = await execAsync('ps -Ao pid,comm');
    const lines = stdout.split('\n');
    const claudePids: number[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;

      const pid = parseInt(parts[0], 10);
      const comm = parts[1];

      if (/^(clauded|claude-code|claude)$/.test(comm)) {
        claudePids.push(pid);
      }
    }

    return claudePids;
  } catch (error) {
    console.error('[Workstream] Error finding Claude processes:', error);
    return [];
  }
}
