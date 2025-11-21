import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  closeMainWindow,
} from '@raycast/api';
import { useState, useEffect } from 'react';
import { loadFromDaemon } from './utils/daemon-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import type { InstanceWithStatus } from './types';

const execAsync = promisify(exec);

// Cache for devctl path
let cachedDevctlPath: string | null = null;

/**
 * Find the path to devctl executable
 */
async function findDevctl(): Promise<string> {
  if (cachedDevctlPath) {
    return cachedDevctlPath;
  }

  // Try common pnpm paths with devctl
  const commonPaths = [
    '/opt/homebrew/bin/pnpm',
    '/usr/local/bin/pnpm',
    `${process.env.HOME}/.local/share/pnpm/pnpm`,
  ];

  for (const pnpmPath of commonPaths) {
    if (existsSync(pnpmPath)) {
      cachedDevctlPath = `${pnpmPath} exec devctl`;
      return cachedDevctlPath;
    }
  }

  // Try to find pnpm using which through a login shell
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await execAsync(`${shell} -l -c 'which pnpm'`);
    const pnpmPath = stdout.trim();
    if (pnpmPath) {
      cachedDevctlPath = `${pnpmPath} exec devctl`;
      return cachedDevctlPath;
    }
  } catch {
    // Ignore error, try next approach
  }

  // Fallback: just try pnpm exec devctl and hope it's in PATH
  cachedDevctlPath = 'pnpm exec devctl';
  return cachedDevctlPath;
}

export default function SetupCaddyRouteCommand() {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadInstances();
  }, []);

  async function loadInstances() {
    setIsLoading(true);

    try {
      const daemonCache = await loadFromDaemon();
      if (daemonCache) {
        // Filter to instances with running tmux but no Caddy config
        const needsSetup = daemonCache.instances.filter((i) => i.tmuxStatus?.exists && !i.caddyHost);
        setInstances(needsSetup);
      } else {
        setInstances([]);
      }
      setIsLoading(false);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load instances',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setInstances([]);
      setIsLoading(false);
    }
  }

  async function setupCaddyRoute(instance: InstanceWithStatus) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: 'Setting up Caddy route...',
        message: instance.name,
      });

      // Find devctl executable path
      const devctlCmd = await findDevctl();

      // Run devctl setup
      const command = `cd "${instance.path}" && ${devctlCmd} setup`;
      await execAsync(command, {
        shell: process.env.SHELL || '/bin/zsh',
      });

      await showToast({
        style: Toast.Style.Success,
        title: 'Caddy route configured',
        message: instance.name,
      });

      // Reload instances to update the list
      await loadInstances();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to setup Caddy route',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  function getSubtitle(instance: InstanceWithStatus): string {
    const parts: string[] = [];

    if (instance.tmuxStatus) {
      parts.push(`tmux: ${instance.tmuxStatus.name}`);
    }

    if (instance.gitInfo?.branch) {
      parts.push(`⎇ ${instance.gitInfo.branch}`);
    }

    return parts.join(' • ');
  }

  function getAccessories(instance: InstanceWithStatus): List.Item.Accessory[] {
    const accessories: List.Item.Accessory[] = [];

    // Show tmux running indicator
    if (instance.tmuxStatus?.exists) {
      accessories.push({
        icon: { source: Icon.Terminal, tintColor: Color.Green },
        tooltip: 'Dev server running',
      });
    }

    // Show warning that Caddy is missing
    accessories.push({
      icon: { source: Icon.ExclamationMark, tintColor: Color.Orange },
      tooltip: 'Caddy route not configured',
    });

    return accessories;
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search instances needing Caddy setup...">
      {instances.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="No instances need Caddy setup"
          description="All instances with running dev servers have Caddy routes configured"
        />
      ) : (
        instances.map((instance) => (
          <List.Item
            key={instance.path}
            icon={{ source: Icon.Network, tintColor: Color.Orange }}
            title={instance.name}
            subtitle={getSubtitle(instance)}
            accessories={getAccessories(instance)}
            actions={
              <ActionPanel>
                <Action
                  title="Setup Caddy Route"
                  onAction={() => setupCaddyRoute(instance)}
                  icon={Icon.Hammer}
                />
                <Action
                  title="Refresh"
                  onAction={loadInstances}
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                />
                <Action.ShowInFinder path={instance.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
