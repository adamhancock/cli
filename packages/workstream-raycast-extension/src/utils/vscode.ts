import { exec } from 'child_process';
import { promisify } from 'util';
import { open } from '@raycast/api';
import path from 'path';
import type { VSCodeInstance } from '../types';

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
