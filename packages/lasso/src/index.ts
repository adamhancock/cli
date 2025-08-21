#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import axios from 'axios';
import open from 'open';
import chalk from 'chalk';
import ora from 'ora';

// Register the autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

interface CaddyHost {
  name: string;
  url: string;
  upstreams?: string[];
  worktreePath?: string;
  routes?: any[];
  isActive?: boolean;
  responseTime?: number;
  statusCode?: number;
}

interface CaddyConfig {
  apps?: {
    http?: {
      servers?: {
        [key: string]: {
          routes?: Array<{
            match?: Array<{
              host?: string[];
            }>;
            handle?: Array<{
              handler?: string;
              upstreams?: Array<{
                dial?: string;
              }>;
            }>;
          }>;
        };
      };
    };
  };
}

class LassoCLI {
  private caddyApiUrl: string;

  constructor(port: number = 2019) {
    this.caddyApiUrl = `http://localhost:${port}`;
  }

  async fetchCaddyConfig(): Promise<CaddyConfig> {
    try {
      const response = await axios.get(`${this.caddyApiUrl}/config/`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          throw new Error(`Cannot connect to Caddy API at ${this.caddyApiUrl}. Is Caddy running?`);
        }
        throw new Error(`Failed to fetch Caddy config: ${error.message}`);
      }
      throw error;
    }
  }

  extractHosts(config: CaddyConfig): CaddyHost[] {
    const hosts: CaddyHost[] = [];
    const seenHosts = new Set<string>();

    if (config.apps?.http?.servers) {
      for (const [serverName, server] of Object.entries(config.apps.http.servers)) {
        if (server.routes) {
          for (const route of server.routes) {
            if (route.match) {
              for (const match of route.match) {
                if (match.host) {
                  for (const host of match.host) {
                    if (!seenHosts.has(host)) {
                      seenHosts.add(host);
                      
                      // Determine protocol based on server configuration
                      const protocol = serverName.includes('https') || serverName === 'srv1' ? 'https' : 'http';
                      
                      // Extract upstreams and worktree path from the route handlers (including subroutes)
                      const upstreams: Set<string> = new Set();
                      let worktreePath: string | undefined;
                      
                      const extractData = (handlers: any[]) => {
                        if (!handlers) return;
                        
                        for (const handler of handlers) {
                          // Direct reverse proxy
                          if (handler.handler === 'reverse_proxy') {
                            if (handler.upstreams) {
                              for (const upstream of handler.upstreams) {
                                if (upstream.dial) {
                                  upstreams.add(upstream.dial);
                                }
                              }
                            }
                            // Extract worktree path from headers
                            if (handler.headers?.response?.set?.['X-Worktree-Path']?.[0]) {
                              worktreePath = handler.headers.response.set['X-Worktree-Path'][0];
                            }
                          }
                          // Subroute handler - recursively check routes inside
                          else if (handler.handler === 'subroute' && handler.routes) {
                            for (const subroute of handler.routes) {
                              if (subroute.handle) {
                                extractData(subroute.handle);
                              }
                            }
                          }
                        }
                      };
                      
                      if (route.handle) {
                        extractData(route.handle);
                      }
                      
                      hosts.push({
                        name: host,
                        url: `${protocol}://${host}`,
                        upstreams: upstreams.size > 0 ? Array.from(upstreams) : undefined,
                        worktreePath,
                        routes: route.handle
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return hosts.sort((a, b) => a.name.localeCompare(b.name));
  }

  async checkHostHealth(host: CaddyHost): Promise<CaddyHost> {
    // If no upstreams, consider it inactive
    if (!host.upstreams || host.upstreams.length === 0) {
      return {
        ...host,
        isActive: false
      };
    }

    const startTime = Date.now();
    
    // Check all upstreams and consider host active if any upstream is reachable
    const upstreamChecks = host.upstreams.map(async (upstream) => {
      try {
        // Convert upstream dial format (e.g., "localhost:3000") to URL
        const upstreamUrl = upstream.startsWith('http') ? upstream : `http://${upstream}`;
        
        const response = await axios.get(upstreamUrl, {
          timeout: 3000,
          validateStatus: () => true, // Accept any status code
          maxRedirects: 0 // Don't follow redirects for upstream checks
        });
        
        return {
          isActive: response.status >= 200 && response.status < 500,
          statusCode: response.status,
          responseTime: Date.now() - startTime
        };
      } catch (error) {
        return {
          isActive: false,
          responseTime: Date.now() - startTime
        };
      }
    });

    const results = await Promise.all(upstreamChecks);
    
    // Host is active if any upstream is active
    const activeUpstream = results.find(r => r.isActive);
    
    return {
      ...host,
      isActive: !!activeUpstream,
      statusCode: activeUpstream?.statusCode,
      responseTime: activeUpstream?.responseTime || Date.now() - startTime
    };
  }

  async checkAllHostsHealth(hosts: CaddyHost[]): Promise<CaddyHost[]> {
    // Check all hosts concurrently for better performance
    const healthChecks = hosts.map(host => this.checkHostHealth(host));
    const checkedHosts = await Promise.all(healthChecks);
    
    // Sort hosts: active ones first, then by name
    return checkedHosts.sort((a, b) => {
      // First sort by active status
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      // Then sort by name
      return a.name.localeCompare(b.name);
    });
  }

  async selectAndOpenHost(hosts: CaddyHost[]): Promise<string> {
    if (hosts.length === 0) {
      console.log(chalk.yellow('No hosts found in Caddy configuration'));
      return 'exit';
    }

    // Build choices array for all options
    const hasOfflineHosts = hosts.some(h => !h.isActive);
    const activeCount = hosts.filter(h => h.isActive).length;
    
    // Create host choices with metadata
    const hostChoices = hosts.map(host => {
      const statusIcon = host.isActive ? chalk.green('●') : chalk.red('●');
      const responseTime = host.responseTime ? chalk.gray(`${host.responseTime}ms`) : '';
      const hostName = host.isActive ? chalk.cyan(host.name) : chalk.gray(host.name);
      const upstream = host.upstreams && host.upstreams.length > 0 
        ? chalk.gray(`→ ${host.upstreams.join(', ')}`)
        : chalk.gray('→ (no upstream)');
      
      return {
        name: `${statusIcon} ${hostName} ${responseTime} ${upstream}`,
        value: host.url,
        short: host.name,
        searchText: host.name.toLowerCase(), // For search filtering
        disabled: !host.isActive ? chalk.red('(Backend offline)') : false,
        host: host
      };
    });

    // Create action choices
    const actionChoices = [
      { name: chalk.yellow('[r] ↻ Refresh now'), value: 'REFRESH', short: 'Refresh', searchText: 'refresh' }
    ];
    
    if (hasOfflineHosts) {
      actionChoices.push(
        { name: chalk.red('[c] 🧹 Cleanup offline hosts'), value: 'CLEANUP', short: 'Cleanup', searchText: 'cleanup' }
      );
    }
    
    actionChoices.push(
      { name: chalk.gray('[q] Exit'), value: 'EXIT', short: 'Exit', searchText: 'exit quit' }
    );

    // Combine all choices - hosts first, then actions
    const allChoices = [...hostChoices, ...actionChoices];
    
    const message = chalk.bold('Select a host (type to filter):') + 
      chalk.gray(` (${activeCount} active, ${hosts.length - activeCount} offline)`);

    const { selectedUrl } = await inquirer.prompt([
      {
        type: 'autocomplete' as any,
        name: 'selectedUrl',
        message,
        pageSize: 20,
        source: async (_answersSoFar: any, input: string) => {
          if (!input) {
            // Show all choices when no input
            return allChoices;
          }
          
          // Filter and sort choices based on input
          const searchTerm = input.toLowerCase();
          const filtered = allChoices.filter(choice => {
            // Check if it's a separator (skip)
            if (!choice.value) return false;
            
            // Search in searchText field or name
            const searchableText = choice.searchText || choice.name.toLowerCase();
            return searchableText.includes(searchTerm);
          });
          
          // Sort results: starts-with matches first, then contains matches
          return filtered.sort((a, b) => {
            const aText = a.searchText || a.name.toLowerCase();
            const bText = b.searchText || b.name.toLowerCase();
            const aStartsWith = aText.startsWith(searchTerm);
            const bStartsWith = bText.startsWith(searchTerm);
            
            if (aStartsWith && !bStartsWith) return -1;
            if (!aStartsWith && bStartsWith) return 1;
            
            // If both start with or both don't, maintain original order
            return 0;
          });
        },
        emptyText: 'No matching hosts found'
      }
    ]);

    if (selectedUrl === 'EXIT') {
      return 'exit';
    } else if (selectedUrl === 'REFRESH') {
      return 'refresh';
    } else if (selectedUrl === 'CLEANUP') {
      await this.cleanupOfflineHosts(hosts);
      return 'refresh';
    } else if (selectedUrl) {
      // Find the selected host
      const selectedHost = hosts.find(h => h.url === selectedUrl);
      
      if (selectedHost) {
        // Ask how to open
        const openChoices = [
          { name: chalk.cyan('🌐 Open in browser'), value: 'browser' },
        ];
        
        if (selectedHost.worktreePath) {
          openChoices.push({ name: chalk.blue('📝 Open folder in VSCode'), value: 'vscode' });
        }
        
        openChoices.push({ name: chalk.gray('← Back'), value: 'back' });
        
        const { openMethod } = await inquirer.prompt([
          {
            type: 'list',
            name: 'openMethod',
            message: `How would you like to open ${chalk.cyan(selectedHost.name)}?`,
            choices: openChoices
          }
        ]);
        
        if (openMethod === 'browser') {
          console.log(chalk.green(`Opening ${selectedUrl} in browser...`));
          await open(selectedUrl);
        } else if (openMethod === 'vscode' && selectedHost.worktreePath) {
          console.log(chalk.blue(`Opening ${selectedHost.worktreePath} in VSCode...`));
          const { exec } = require('child_process');
          exec(`code "${selectedHost.worktreePath}"`, (error: any) => {
            if (error) {
              console.error(chalk.red(`Failed to open in VSCode: ${error.message}`));
            }
          });
          await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause
        }
      }
      
      return 'continue';
    }
    
    return 'continue';
  }

  async listHosts(hosts: CaddyHost[]): Promise<void> {
    if (hosts.length === 0) {
      console.log(chalk.yellow('No hosts found in Caddy configuration'));
      return;
    }

    console.log(chalk.bold('\nCaddy Hosts:\n'));
    
    // Check if health checks were performed
    const healthChecked = hosts.some(h => h.isActive !== undefined);
    
    if (healthChecked) {
      // Show active hosts first
      const activeHosts = hosts.filter(h => h.isActive);
      const inactiveHosts = hosts.filter(h => !h.isActive);
      
      if (activeHosts.length > 0) {
        console.log(chalk.green.bold('  Active (backend running):\n'));
        for (const host of activeHosts) {
          const responseTime = host.responseTime ? chalk.gray(`${host.responseTime}ms`) : '';
          const upstream = host.upstreams && host.upstreams.length > 0 
            ? chalk.gray(`→ ${host.upstreams.join(', ')}`)
            : '';
          console.log(`  ${chalk.green('●')} ${chalk.cyan(host.name.padEnd(40))} ${responseTime.padEnd(8)} ${upstream}`);
        }
      }
      
      if (inactiveHosts.length > 0) {
        console.log(chalk.red.bold('\n  Offline (backend unreachable):\n'));
        for (const host of inactiveHosts) {
          const upstream = host.upstreams && host.upstreams.length > 0 
            ? chalk.gray.dim(`→ ${host.upstreams.join(', ')}`)
            : chalk.gray.dim('→ (no upstream)');
          console.log(`  ${chalk.red('●')} ${chalk.gray(host.name.padEnd(40))} ${upstream}`);
        }
      }
      
      console.log('');
      console.log(chalk.gray(`  Total: ${hosts.length} hosts (${activeHosts.length} active, ${inactiveHosts.length} offline)\n`));
    } else {
      // No health checks performed, just list hosts
      for (const host of hosts) {
        const upstream = host.upstreams && host.upstreams.length > 0 
          ? chalk.gray(`→ ${host.upstreams.join(', ')}`)
          : chalk.gray('→ (no upstream)');
        console.log(`  ${chalk.cyan(host.name.padEnd(40))} ${upstream}`);
      }
      console.log('');
    }
  }

  async cleanupOfflineHosts(hosts: CaddyHost[]): Promise<void> {
    const offlineHosts = hosts.filter(h => !h.isActive);
    
    if (offlineHosts.length === 0) {
      console.log(chalk.green('All hosts are active, nothing to clean up'));
      return;
    }

    console.log(chalk.yellow(`\nFound ${offlineHosts.length} offline host(s):\n`));
    for (const host of offlineHosts) {
      const upstream = host.upstreams && host.upstreams.length > 0 
        ? chalk.gray(`→ ${host.upstreams.join(', ')}`)
        : chalk.gray('→ (no upstream)');
      console.log(`  ${chalk.red('●')} ${chalk.gray(host.name)} ${upstream}`);
    }

    const { confirmCleanup } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmCleanup',
        message: `Remove ${offlineHosts.length} offline host(s) from Caddy configuration?`,
        default: false
      }
    ]);

    if (!confirmCleanup) {
      console.log(chalk.gray('Cleanup cancelled'));
      return;
    }

    const spinner = ora('Removing offline hosts from Caddy...').start();

    try {
      // Get current config
      const config = await this.fetchCaddyConfig();
      
      // Create a set of offline host names for quick lookup
      const offlineHostNames = new Set(offlineHosts.map(h => h.name));
      
      // Find routes to delete (track by server and index)
      const routesToDelete: Array<{server: string, routeIndex: number, routeId?: string}> = [];
      
      if (config.apps?.http?.servers) {
        for (const [serverName, server] of Object.entries(config.apps.http.servers)) {
          if (server.routes) {
            // Go through routes in reverse order to track indices for deletion
            for (let i = server.routes.length - 1; i >= 0; i--) {
              const route = server.routes[i];
              if (route.match) {
                for (const match of route.match) {
                  if (match.host) {
                    // Check if any host in this route is offline
                    const hasOfflineHost = match.host.some(host => offlineHostNames.has(host));
                    if (hasOfflineHost) {
                      routesToDelete.push({
                        server: serverName,
                        routeIndex: i,
                        routeId: (route as any)['@id']
                      });
                      break; // Found offline host, mark for deletion
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Delete routes one by one (in reverse order to maintain indices)
      let deletedCount = 0;
      for (const {server, routeIndex, routeId} of routesToDelete) {
        try {
          const path = `/config/apps/http/servers/${server}/routes/${routeIndex}`;
          await axios.delete(`${this.caddyApiUrl}${path}`);
          deletedCount++;
          spinner.text = `Removed ${deletedCount}/${routesToDelete.length} route(s)...`;
        } catch (err) {
          // Continue even if one fails
          console.warn(chalk.yellow(`Failed to delete route ${routeId || routeIndex}`));
        }
      }

      spinner.succeed(`Removed ${deletedCount} route(s) with offline hosts from Caddy configuration`);
      
      // Show removed hosts
      console.log(chalk.green('\nRemoved hosts:'));
      for (const host of offlineHosts) {
        console.log(`  ${chalk.red('✗')} ${chalk.gray(host.name)}`);
      }
      
    } catch (error) {
      spinner.fail('Failed to update Caddy configuration');
      if (axios.isAxiosError(error)) {
        console.error(chalk.red(`Error: ${error.message}`));
        if (error.response?.data) {
          console.error(chalk.red('Response:', JSON.stringify(error.response.data, null, 2)));
        }
      } else {
        console.error(chalk.red((error as Error).message));
      }
      process.exit(1);
    }
  }

  async fetchAndCheckHosts(showSpinner: boolean = true): Promise<CaddyHost[]> {
    const spinner = showSpinner ? ora('Fetching Caddy configuration...').start() : null;
    
    try {
      const config = await this.fetchCaddyConfig();
      let hosts = this.extractHosts(config);
      
      if (spinner) spinner.text = `Found ${hosts.length} host(s), checking health...`;
      
      // Check health of all hosts
      hosts = await this.checkAllHostsHealth(hosts);
      
      const activeCount = hosts.filter(h => h.isActive).length;
      if (spinner) spinner.succeed(`Found ${hosts.length} host(s): ${activeCount} active, ${hosts.length - activeCount} offline`);
      
      return hosts;
    } catch (error) {
      if (spinner) spinner.fail('Failed to fetch Caddy configuration');
      throw error;
    }
  }

  async runInteractive(): Promise<void> {
    let lastRefresh = Date.now();
    const refreshInterval = 30000; // 30 seconds
    
    while (true) {
      console.clear();
      
      // Show last refresh time and next refresh countdown
      const timeSinceRefresh = Date.now() - lastRefresh;
      const timeUntilRefresh = Math.max(0, refreshInterval - timeSinceRefresh);
      const secondsUntilRefresh = Math.ceil(timeUntilRefresh / 1000);
      
      console.log(chalk.gray(`Last refresh: ${new Date(lastRefresh).toLocaleTimeString()}`));
      console.log(chalk.gray(`Next auto-refresh in: ${secondsUntilRefresh}s\n`));
      
      try {
        const hosts = await this.fetchAndCheckHosts(true);
        
        // Check if it's time for auto-refresh
        if (Date.now() - lastRefresh >= refreshInterval) {
          lastRefresh = Date.now();
          continue;
        }
        
        const action = await this.selectAndOpenHost(hosts);
        
        if (action === 'exit') {
          break;
        } else if (action === 'refresh') {
          lastRefresh = Date.now();
          continue;
        } else if (action === 'continue') {
          // After opening a host, refresh and continue
          await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause
          lastRefresh = Date.now();
          continue;
        }
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        break;
      }
    }
  }

  async run(options: { list?: boolean; port?: number; skipHealth?: boolean; cleanup?: boolean }): Promise<void> {
    if (options.port) {
      this.caddyApiUrl = `http://localhost:${options.port}`;
    }

    if (options.cleanup) {
      const hosts = await this.fetchAndCheckHosts(true);
      await this.cleanupOfflineHosts(hosts);
    } else if (options.list) {
      const spinner = ora('Fetching Caddy configuration...').start();
      try {
        const config = await this.fetchCaddyConfig();
        let hosts = this.extractHosts(config);
        
        if (!options.skipHealth) {
          spinner.text = `Found ${hosts.length} host(s), checking health...`;
          hosts = await this.checkAllHostsHealth(hosts);
          const activeCount = hosts.filter(h => h.isActive).length;
          spinner.succeed(`Found ${hosts.length} host(s): ${activeCount} active, ${hosts.length - activeCount} offline`);
        } else {
          spinner.succeed(`Found ${hosts.length} host(s)`);
        }
        
        await this.listHosts(hosts);
      } catch (error) {
        spinner.fail('Failed to fetch Caddy configuration');
        console.error(chalk.red((error as Error).message));
        process.exit(1);
      }
    } else {
      // Interactive mode with auto-refresh
      await this.runInteractive();
    }
  }
}

const program = new Command();

program
  .name('lasso')
  .description('Read Caddy API and interactively open configured hosts')
  .version('1.0.0')
  .option('-l, --list', 'List all hosts without interactive selection')
  .option('-p, --port <port>', 'Caddy API port (default: 2019)', '2019')
  .option('-s, --skip-health', 'Skip health checks for faster listing')
  .option('-c, --cleanup', 'Remove offline hosts from Caddy configuration')
  .action(async (options) => {
    const cli = new LassoCLI();
    await cli.run({
      list: options.list,
      port: parseInt(options.port),
      skipHealth: options.skipHealth,
      cleanup: options.cleanup
    });
  });

program.parse(process.argv);