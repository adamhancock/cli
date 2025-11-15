import { exec } from 'child_process';
import { promisify } from 'util';
import { open } from '@raycast/api';
import path from 'path';
import type { VSCodeInstance } from '../types';
import { getPublisherClient, isRedisAvailable } from './redis-client';

const execAsync = promisify(exec);
const VS_CODE_BUNDLE_ID = 'com.microsoft.VSCode';

/**
 * Get all open VS Code instances using lsof to find working directories
 */
export async function getVSCodeInstances(): Promise<VSCodeInstance[]> {
  try {
    // Use lsof to find the current working directories of VS Code processes
    const { stdout, stderr } = await execAsync(
      `/bin/bash -c "/usr/sbin/lsof -c 'Code Helper' -a -d cwd -Fn | grep '^n/' | cut -c2- | sort -u"`,
      { maxBuffer: 1024 * 1024, shell: '/bin/bash' }
    );

    if (stderr) {
      console.error('stderr from lsof:', stderr);
    }

    if (!stdout.trim()) {
      return [];
    }

    // Filter out root directory and any invalid paths
    const folderPaths = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((p) => p !== '/' && p.length > 1);

    const instances: VSCodeInstance[] = [];

    for (const folderPath of folderPaths) {
      const name = path.basename(folderPath);

      // Check if it's a git repository and get branch
      let branch: string | undefined;
      let isGitRepo = false;

      try {
        const { stdout: branchOutput } = await execAsync(
          `/usr/bin/git -C "${folderPath}" rev-parse --abbrev-ref HEAD`
        );
        branch = branchOutput.trim();
        isGitRepo = true;
      } catch {
        // Not a git repo or git command failed
      }

      instances.push({
        name,
        path: folderPath,
        branch,
        isGitRepo,
      });
    }

    return instances;
  } catch (error) {
    // Log error for debugging
    console.error('Error getting VS Code instances:', error);
    throw error; // Propagate error so we can see it in Raycast
  }
}

/**
 * Focus/activate a VS Code instance by folder path using Raycast's open API
 * This is the recommended approach from official Raycast extensions
 */
export async function focusVSCodeInstance(folderPath: string): Promise<void> {
  // Use file:// URI format that VS Code expects
  const uri = `file://${folderPath}`;
  await open(uri, VS_CODE_BUNDLE_ID);
}

/**
 * Close a VS Code window by folder path
 * Uses AppleScript to close the window gracefully, then kills processes if needed
 */
export async function closeVSCodeInstance(folderPath: string): Promise<void> {
  try {
    const windowName = path.basename(folderPath);

    // First, try to close the window gracefully using AppleScript
    try {
      await execAsync(
        `osascript -e 'tell application "Visual Studio Code"' -e 'set windowCount to count of windows' -e 'repeat with i from 1 to windowCount' -e 'set windowName to name of window i' -e 'if windowName contains "${windowName}" then' -e 'close window i' -e 'exit repeat' -e 'end if' -e 'end repeat' -e 'end tell'`
      );

      // Give VS Code a moment to close gracefully
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (appleScriptError) {
      console.log('AppleScript close failed, will try process kill:', appleScriptError);
    }

    // Check if processes still exist and kill them if needed
    try {
      const { stdout } = await execAsync(
        `/usr/sbin/lsof -c 'Code Helper' -a -d cwd -Fn 2>/dev/null | grep -B1 '^n${folderPath}$' | grep '^p' | cut -c2- || true`
      );

      const pids = stdout.trim().split('\n').filter(Boolean);

      if (pids.length > 0) {
        console.log(`Killing ${pids.length} remaining processes for ${folderPath}`);
        for (const pid of pids) {
          try {
            await execAsync(`kill ${pid}`);
          } catch (killError) {
            // Process might already be gone, ignore
            console.log(`Failed to kill process ${pid}:`, killError);
          }
        }
      }
    } catch (lsofError) {
      // If we can't find processes, assume it closed successfully
      console.log('No processes found or already closed');
    }
  } catch (error) {
    throw new Error(`Failed to close VS Code: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Launch a new terminal in a VS Code instance and run the clauded command
 * Uses Redis pub/sub to communicate with the VS Code extension
 */
export async function launchClaudeTerminal(instance: VSCodeInstance): Promise<boolean> {
  try {
    if (!(await isRedisAvailable())) {
      return false;
    }

    const publisher = getPublisherClient();
    const workspace = Buffer.from(instance.path).toString('base64');
    const channel = `workstream:terminal:create:${workspace}`;

    await publisher.publish(
      channel,
      JSON.stringify({
        command: 'clauded',
        terminalName: 'Claude'
      })
    );

    console.log(`Published terminal creation request for ${instance.path}`);
    return true;
  } catch (error) {
    console.error('Failed to launch Claude terminal:', error);
    return false;
  }
}
