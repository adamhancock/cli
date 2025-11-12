import { exec } from 'child_process';
import { promisify } from 'util';
import { open } from '@raycast/api';
import path from 'path';
import type { VSCodeInstance } from '../types';

const execAsync = promisify(exec);
const VS_CODE_BUNDLE_ID = 'com.microsoft.VSCode';

/**
 * Get window order from VS Code using AppleScript
 * Returns map of folder name to window index (lower = more recent)
 */
async function getVSCodeWindowOrder(): Promise<Map<string, number>> {
  const orderMap = new Map<string, number>();

  try {
    const script = `
      tell application "System Events"
        if not (exists process "Code") then
          return ""
        end if

        tell process "Code"
          set windowNames to name of every window
          return windowNames as text
        end tell
      end tell
    `;

    const { stdout } = await execAsync(`/usr/bin/osascript -e '${script.replace(/'/g, "'\\''")}'`);

    if (!stdout.trim()) {
      return orderMap;
    }

    // Window names are comma-separated, frontmost (most recent) is first
    const windowNames = stdout.trim().split(', ');
    windowNames.forEach((windowName, index) => {
      // VS Code window titles often end with " - folder-name"
      // Extract the folder name from the window title
      const match = windowName.match(/^(.+?)\s*(?:—|-)?\s*([^—-]+)$/);
      if (match && match[2]) {
        const folderName = match[2].trim();
        // Lower index = more recent (frontmost window = index 0)
        orderMap.set(folderName, index);
      }
    });
  } catch (error) {
    console.warn('Failed to get VS Code window order:', error);
  }

  return orderMap;
}

/**
 * Get last activity time for a workspace by checking file modification times
 */
async function getLastActivityTime(folderPath: string): Promise<Date> {
  try {
    // Check most recently modified file in workspace (excluding node_modules, .git, etc.)
    const { stdout } = await execAsync(
      `/usr/bin/find "${folderPath}" -type f ` +
      `-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" ` +
      `-exec stat -f "%m %N" {} + 2>/dev/null | sort -rn | head -1`,
      { maxBuffer: 1024 * 1024 }
    );

    if (stdout.trim()) {
      const timestamp = parseInt(stdout.trim().split(' ')[0]);
      return new Date(timestamp * 1000);
    }
  } catch (error) {
    // Ignore errors, fall back to current time
  }

  // Fall back to current time
  return new Date();
}

/**
 * Get all open VS Code instances using lsof to find working directories
 * Instances are ordered by last used (most recent first)
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

    // Get window order (for accurate "last used" ordering)
    const windowOrder = await getVSCodeWindowOrder();

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

      // Get last activity time for sorting
      const lastActivityTime = await getLastActivityTime(folderPath);

      instances.push({
        name,
        path: folderPath,
        branch,
        isGitRepo,
        lastActivityTime,
        windowOrder: windowOrder.get(name),
      });
    }

    // Sort by window order first (if available), then by last activity time
    instances.sort((a, b) => {
      // If both have window order, use that (lower index = more recent)
      if (a.windowOrder !== undefined && b.windowOrder !== undefined) {
        return a.windowOrder - b.windowOrder;
      }
      // If only one has window order, prioritize it
      if (a.windowOrder !== undefined) return -1;
      if (b.windowOrder !== undefined) return 1;

      // Fall back to last activity time (more recent first)
      return b.lastActivityTime.getTime() - a.lastActivityTime.getTime();
    });

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
