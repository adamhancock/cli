import { showToast, Toast, closeMainWindow } from '@raycast/api';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadFromDaemon, loadFromRedis } from './utils/daemon-client';
import { findChromeTab, switchToChromeTab, openNewChromeTab, resolveTargetChromeProfile } from './utils/chrome';

const execAsync = promisify(exec);

async function getActiveVSCodeInstancePath(): Promise<string | null> {
  try {
    // First check if VS Code is the frontmost app
    // Note: VS Code can show as "Visual Studio Code", "Electron", or "Code"
    const frontAppScript = `tell application "System Events" to get name of first process whose frontmost is true`;
    const { stdout: frontApp } = await execAsync(`osascript -e '${frontAppScript}'`);
    const activeApp = frontApp.trim();

    // Accept VS Code by various process names
    const isVSCode = activeApp === 'Visual Studio Code' ||
                     activeApp === 'Electron' ||
                     activeApp === 'Code';

    if (!isVSCode) {
      return null;
    }

    // Get the active window name
    // Use a try-catch approach since VS Code doesn't support "count of windows"
    const windowScript = `
      tell application "Visual Studio Code"
        try
          return name of front window
        on error
          return ""
        end try
      end tell
    `;

    const { stdout } = await execAsync(`osascript -e '${windowScript.replace(/'/g, "'\"'\"'")}'`);
    let windowName = stdout.trim();

    if (!windowName) return null;

    // VS Code window names often include " - Visual Studio Code" suffix, remove it
    windowName = windowName.replace(/ - Visual Studio Code$/, '');

    // Load instances from daemon/Redis to match window name to path
    const redisCache = await loadFromRedis();
    if (redisCache) {
      // Try exact match first
      let instance = redisCache.instances.find((i) => i.name === windowName);

      // If no exact match, try partial matching (window name contains folder name or vice versa)
      if (!instance) {
        instance = redisCache.instances.find((i) =>
          windowName.includes(i.name) || i.name.includes(windowName)
        );
      }

      if (instance) return instance.path;
    }

    // Fallback to daemon file cache
    const daemonCache = await loadFromDaemon();
    if (daemonCache) {
      // Try exact match first
      let instance = daemonCache.instances.find((i) => i.name === windowName);

      // If no exact match, try partial matching
      if (!instance) {
        instance = daemonCache.instances.find((i) =>
          windowName.includes(i.name) || i.name.includes(windowName)
        );
      }

      if (instance) return instance.path;
    }

    return null;
  } catch (error) {
    console.error('Failed to get active VS Code window:', error);
    return null;
  }
}

async function getInstanceDevUrl(instancePath: string): Promise<string | null> {
  // Try Redis first (fastest)
  const redisCache = await loadFromRedis();
  if (redisCache) {
    const instance = redisCache.instances.find((i) => i.path === instancePath);
    if (instance?.caddyHost) {
      return instance.caddyHost.url;
    }
  }

  // Fallback to daemon file cache
  const daemonCache = await loadFromDaemon();
  if (daemonCache) {
    const instance = daemonCache.instances.find((i) => i.path === instancePath);
    if (instance?.caddyHost) {
      return instance.caddyHost.url;
    }
  }

  return null;
}

export default async function Command() {
  try {
    // Resolve Chrome profile to use
    const chromeProfile = await resolveTargetChromeProfile();

    // Step 1: Get active VS Code instance
    await showToast({
      style: Toast.Style.Animated,
      title: 'Looking for active VS Code window...',
    });

    // Get the active app name first for better error messages
    const frontAppScript = `tell application "System Events" to get name of first process whose frontmost is true`;
    const { stdout: frontApp } = await execAsync(`osascript -e '${frontAppScript}'`);
    const activeApp = frontApp.trim();

    const instancePath = await getActiveVSCodeInstancePath();

    if (!instancePath) {
      // Check if VS Code is active (by any of its process names)
      const isVSCodeActive = activeApp === 'Visual Studio Code' ||
                            activeApp === 'Electron' ||
                            activeApp === 'Code';

      // Try to get the window name for debugging
      let debugMessage = isVSCodeActive ? 'No VS Code window is open' : `Currently active: ${activeApp}`;

      if (isVSCodeActive) {
        try {
          const windowScript = `
            tell application "Visual Studio Code"
              try
                return name of front window
              on error
                return "No windows open"
              end try
            end tell
          `;
          const { stdout } = await execAsync(`osascript -e '${windowScript.replace(/'/g, "'\"'\"'")}'`);
          const rawWindowName = stdout.trim();
          if (rawWindowName === 'No windows open') {
            debugMessage = 'VS Code is open but has no windows';
          } else {
            debugMessage = `Window: "${rawWindowName}" - Could not match to daemon data`;
          }
        } catch (error) {
          debugMessage = 'Could not get VS Code window name';
        }
      }

      await showToast({
        style: Toast.Style.Failure,
        title: 'No active VS Code window',
        message: debugMessage,
      });
      return;
    }

    const instanceName = instancePath.split('/').pop() || instancePath;

    // Step 2: Get dev URL
    await showToast({
      style: Toast.Style.Animated,
      title: `Getting dev URL for ${instanceName}...`,
    });

    const devUrl = await getInstanceDevUrl(instancePath);

    if (!devUrl) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'No dev environment found',
        message: `${instanceName} does not have a Caddy-hosted dev environment`,
      });
      return;
    }

    // Step 3: Check if Chrome tab exists
    await showToast({
      style: Toast.Style.Animated,
      title: 'Checking Chrome tabs...',
    });

    const existingTab = await findChromeTab(devUrl);

    // Step 4: Open or switch to tab
    if (existingTab) {
      await switchToChromeTab(existingTab.windowId, existingTab.tabIndex, chromeProfile);
      await showToast({
        style: Toast.Style.Success,
        title: 'Switched to existing tab',
        message: devUrl,
      });
    } else {
      await openNewChromeTab(devUrl, chromeProfile);
      await showToast({
        style: Toast.Style.Success,
        title: 'Opened in new tab',
        message: devUrl,
      });
    }

    // Step 5: Close Raycast
    await closeMainWindow();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to open dev instance',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
