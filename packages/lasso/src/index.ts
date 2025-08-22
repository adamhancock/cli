#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import autocompletePrompt from 'inquirer-autocomplete-prompt';
import axios from 'axios';
import open from 'open';
import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { promisify } from 'util';

// Register the autocomplete prompt
inquirer.registerPrompt('autocomplete', autocompletePrompt);

const execAsync = promisify(exec);

interface GitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  modified?: number;
  untracked?: number;
  staged?: number;
  clean?: boolean;
  lastCommit?: {
    hash?: string;
    message?: string;
    author?: string;
    date?: string;
  };
  remoteBranch?: string;
  pullRequest?: {
    number?: number;
    title?: string;
    url?: string;
    state?: string;
    author?: string;
    checks?: {
      total?: number;
      passing?: number;
      failing?: number;
      pending?: number;
      conclusion?: string;
      runs?: Array<{
        name: string;
        state: string;
        bucket: string;
      }>;
    };
  };
}

interface CaddyHost {
  name: string;
  url: string;
  upstreams?: string[];
  worktreePath?: string;
  routes?: any[];
  isActive?: boolean;
  responseTime?: number;
  statusCode?: number;
  gitStatus?: GitStatus;
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

  async getPullRequestInfo(path: string, branch: string): Promise<any> {
    try {
      // First check if this is a GitHub repository
      const { stdout: remoteUrl } = await execAsync(`git -C "${path}" remote get-url origin 2>/dev/null`);
      if (!remoteUrl.includes('github.com')) {
        return undefined;
      }

      // Use gh CLI to get PR info for the branch
      const { stdout: prData } = await execAsync(`gh pr view "${branch}" --repo="$(git -C "${path}" remote get-url origin)" --json number,title,url,state,author 2>/dev/null`);
      
      if (prData.trim()) {
        const pr = JSON.parse(prData);
        
        // Get check status for open PRs
        let checks = undefined;
        if (pr.state === 'OPEN') {
          try {
            const { stdout: checksData } = await execAsync(`gh pr checks "${branch}" --repo="$(git -C "${path}" remote get-url origin)" --json bucket,name,state 2>/dev/null`);
            
            
            if (checksData.trim()) {
              const checkRuns = JSON.parse(checksData);
              const total = checkRuns.length;
              let passing = 0;
              let failing = 0;
              let pending = 0;
              let overallConclusion = 'success';
              
              for (const check of checkRuns) {
                if (check.bucket === 'pass') {
                  passing++;
                } else if (check.bucket === 'fail' || check.bucket === 'cancel') {
                  failing++;
                  overallConclusion = 'failure';
                } else if (check.bucket === 'pending' || check.bucket === 'skipping') {
                  pending++;
                  if (overallConclusion === 'success') {
                    overallConclusion = 'pending';
                  }
                }
              }
              
              checks = {
                total,
                passing,
                failing,
                pending,
                conclusion: overallConclusion,
                runs: checkRuns.map((check: any) => ({
                  name: check.name,
                  state: check.state,
                  bucket: check.bucket
                }))
              };
            }
          } catch {
            // Failed to get checks, continue without them
          }
        }
        
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author?.login,
          checks
        };
      }
    } catch {
      // No PR found, gh not available, or not authenticated
    }
    return undefined;
  }

  async getGitStatus(path: string): Promise<GitStatus | undefined> {
    try {
      // Get current branch
      const { stdout: branch } = await execAsync(`git -C "${path}" rev-parse --abbrev-ref HEAD 2>/dev/null`);
      
      // Get status porcelain for parsing
      const { stdout: status } = await execAsync(`git -C "${path}" status --porcelain 2>/dev/null`);
      
      // Get remote branch
      let remoteBranch = undefined;
      try {
        const { stdout: remote } = await execAsync(`git -C "${path}" rev-parse --abbrev-ref @{u} 2>/dev/null`);
        remoteBranch = remote.trim();
      } catch {
        // No upstream branch
      }
      
      // Get ahead/behind info
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: revList } = await execAsync(`git -C "${path}" rev-list --left-right --count HEAD...@{u} 2>/dev/null`);
        const [aheadStr, behindStr] = revList.trim().split('\t');
        ahead = parseInt(aheadStr) || 0;
        behind = parseInt(behindStr) || 0;
      } catch {
        // No upstream branch or other error, ignore
      }
      
      // Get last commit info
      let lastCommit = undefined;
      try {
        const { stdout: commitInfo } = await execAsync(`git -C "${path}" log -1 --pretty=format:"%h|%s|%an|%ar" 2>/dev/null`);
        const [hash, message, author, date] = commitInfo.split('|');
        lastCommit = { hash, message, author, date };
      } catch {
        // No commits or error
      }

      // Get PR info if available
      const pullRequest = branch.trim() !== 'main' && branch.trim() !== 'master' 
        ? await this.getPullRequestInfo(path, branch.trim())
        : undefined;
      
      // Parse status
      const lines = status.trim().split('\n').filter(l => l);
      let modified = 0;
      let untracked = 0;
      let staged = 0;
      
      for (const line of lines) {
        if (line.startsWith('??')) {
          untracked++;
        } else if (line[0] !== ' ' && line[0] !== '?') {
          staged++;
        }
        if (line[1] === 'M' || line[1] === 'D') {
          modified++;
        }
      }
      
      return {
        branch: branch.trim(),
        remoteBranch,
        ahead,
        behind,
        modified,
        untracked,
        staged,
        clean: lines.length === 0,
        lastCommit,
        pullRequest
      };
    } catch {
      // Not a git repo or git not available
      return undefined;
    }
  }

  formatGitStatus(gitStatus?: GitStatus): string {
    if (!gitStatus) return '';
    
    const parts: string[] = [];
    
    // Branch name
    if (gitStatus.branch) {
      parts.push(chalk.magenta(`⎇ ${gitStatus.branch}`));
    }
    
    // PR info (compact)
    if (gitStatus.pullRequest) {
      const prState = gitStatus.pullRequest.state;
      let prDisplay = `#${gitStatus.pullRequest.number}`;
      
      if (prState === 'OPEN') {
        // Add check status for open PRs
        if (gitStatus.pullRequest.checks) {
          const checks = gitStatus.pullRequest.checks;
          if (checks.conclusion === 'success') {
            prDisplay += ' ✅';
          } else if (checks.conclusion === 'failure') {
            prDisplay += ' ❌';
          } else if (checks.conclusion === 'pending') {
            prDisplay += ' 🟡';
          }
        }
        parts.push(chalk.green(prDisplay));
      } else if (prState === 'MERGED') {
        parts.push(chalk.blue(`${prDisplay} ✓`));
      } else if (prState === 'CLOSED') {
        parts.push(chalk.red(`${prDisplay} ✗`));
      } else {
        parts.push(chalk.gray(prDisplay));
      }
    }
    
    // Clean status
    if (gitStatus.clean) {
      parts.push(chalk.green('✓'));
    } else {
      // Modified files
      if (gitStatus.modified && gitStatus.modified > 0) {
        parts.push(chalk.yellow(`±${gitStatus.modified}`));
      }
      
      // Staged files
      if (gitStatus.staged && gitStatus.staged > 0) {
        parts.push(chalk.green(`●${gitStatus.staged}`));
      }
      
      // Untracked files
      if (gitStatus.untracked && gitStatus.untracked > 0) {
        parts.push(chalk.red(`?${gitStatus.untracked}`));
      }
    }
    
    // Ahead/behind
    if (gitStatus.ahead && gitStatus.ahead > 0) {
      parts.push(chalk.cyan(`↑${gitStatus.ahead}`));
    }
    if (gitStatus.behind && gitStatus.behind > 0) {
      parts.push(chalk.yellow(`↓${gitStatus.behind}`));
    }
    
    return parts.length > 0 ? `[${parts.join(' ')}]` : '';
  }

  displayDetailedGitStatus(gitStatus?: GitStatus): void {
    if (!gitStatus) {
      console.log(chalk.gray('    Git: Not a git repository\n'));
      return;
    }

    console.log(chalk.bold('    Git Status:'));
    
    // Branch info
    if (gitStatus.branch) {
      const branchInfo = gitStatus.remoteBranch 
        ? `${gitStatus.branch} → ${gitStatus.remoteBranch}`
        : gitStatus.branch;
      console.log(`      Branch: ${chalk.magenta(branchInfo)}`);
    }
    
    // Pull Request info
    if (gitStatus.pullRequest) {
      const prState = gitStatus.pullRequest.state;
      let prStateColor = chalk.gray;
      let prStateIcon = '';
      
      if (prState === 'OPEN') {
        prStateColor = chalk.green;
        prStateIcon = '🟢';
      } else if (prState === 'MERGED') {
        prStateColor = chalk.blue;
        prStateIcon = '🔵 ✓';
      } else if (prState === 'CLOSED') {
        prStateColor = chalk.red;
        prStateIcon = '🔴 ✗';
      }
      
      console.log(`      Pull Request: ${prStateColor(`#${gitStatus.pullRequest.number}`)} ${prStateIcon} ${prStateColor(prState)}`);
      console.log(`      ${chalk.dim('└─')} ${gitStatus.pullRequest.title}`);
      if (gitStatus.pullRequest.author) {
        console.log(`      ${chalk.dim('└─')} by ${gitStatus.pullRequest.author}`);
      }
      
      // Show check status for open PRs
      if (prState === 'OPEN' && gitStatus.pullRequest.checks) {
        const checks = gitStatus.pullRequest.checks;
        let checksStatus = '';
        let checksColor = chalk.gray;
        
        if (checks.conclusion === 'success') {
          checksStatus = `✅ All checks passing (${checks.passing}/${checks.total})`;
          checksColor = chalk.green;
        } else if (checks.conclusion === 'failure') {
          checksStatus = `❌ ${checks.failing || 0} checks failing`;
          if ((checks.passing || 0) > 0) {
            checksStatus += `, ${checks.passing} passing`;
          }
          if ((checks.pending || 0) > 0) {
            checksStatus += `, ${checks.pending} pending`;
          }
          checksStatus += ` (${checks.total || 0} total)`;
          checksColor = chalk.red;
        } else if (checks.conclusion === 'pending') {
          checksStatus = `🟡 ${checks.pending || 0} checks pending`;
          if ((checks.passing || 0) > 0) {
            checksStatus += `, ${checks.passing} passing`;
          }
          if ((checks.failing || 0) > 0) {
            checksStatus += `, ${checks.failing} failing`;
          }
          checksStatus += ` (${checks.total || 0} total)`;
          checksColor = chalk.yellow;
        }
        
        console.log(`      ${chalk.dim('└─')} ${checksColor(checksStatus)}`);
        
        // Show individual check details if available
        if (checks.runs && checks.runs.length > 0) {
          console.log(`      ${chalk.dim('└─')} Check details:`);
          
          for (const run of checks.runs) {
            let statusIcon = '○';
            let statusColor = chalk.gray;
            
            if (run.bucket === 'pass') {
              statusIcon = '✅';
              statusColor = chalk.green;
            } else if (run.bucket === 'fail' || run.bucket === 'cancel') {
              statusIcon = '❌';
              statusColor = chalk.red;
            } else if (run.bucket === 'pending') {
              statusIcon = '🔄';
              statusColor = chalk.yellow;
            } else if (run.bucket === 'skipping') {
              statusIcon = '⏭️';
              statusColor = chalk.gray;
            } else {
              // Fallback to state if bucket is unclear
              if (run.state === 'success') {
                statusIcon = '✅';
                statusColor = chalk.green;
              } else if (run.state === 'failure') {
                statusIcon = '❌';
                statusColor = chalk.red;
              } else {
                statusIcon = '⏳';
                statusColor = chalk.yellow;
              }
            }
            
            console.log(`         ${chalk.dim('•')} ${statusIcon} ${statusColor(run.name)}`);
          }
        }
      }
      
      if (gitStatus.pullRequest.url) {
        console.log(`      ${chalk.dim('└─')} ${chalk.blue(gitStatus.pullRequest.url)}`);
      }
    }
    
    // Last commit
    if (gitStatus.lastCommit) {
      console.log(`      Last commit: ${chalk.yellow(gitStatus.lastCommit.hash)} ${chalk.gray(gitStatus.lastCommit.date)}`);
      console.log(`      ${chalk.dim('└─')} ${gitStatus.lastCommit.message}`);
      console.log(`      ${chalk.dim('└─')} by ${gitStatus.lastCommit.author}`);
    }
    
    // Working directory status
    if (gitStatus.clean) {
      console.log(`      Working tree: ${chalk.green('clean')}`);
    } else {
      const statusParts: string[] = [];
      if (gitStatus.staged && gitStatus.staged > 0) {
        statusParts.push(chalk.green(`${gitStatus.staged} staged`));
      }
      if (gitStatus.modified && gitStatus.modified > 0) {
        statusParts.push(chalk.yellow(`${gitStatus.modified} modified`));
      }
      if (gitStatus.untracked && gitStatus.untracked > 0) {
        statusParts.push(chalk.red(`${gitStatus.untracked} untracked`));
      }
      console.log(`      Working tree: ${statusParts.join(', ')}`);
    }
    
    // Remote status
    if (gitStatus.remoteBranch) {
      const remoteParts: string[] = [];
      if (gitStatus.ahead && gitStatus.ahead > 0) {
        remoteParts.push(chalk.cyan(`${gitStatus.ahead} ahead`));
      }
      if (gitStatus.behind && gitStatus.behind > 0) {
        remoteParts.push(chalk.yellow(`${gitStatus.behind} behind`));
      }
      
      if (remoteParts.length > 0) {
        console.log(`      Remote sync: ${remoteParts.join(', ')}`);
      } else if (gitStatus.ahead === 0 && gitStatus.behind === 0) {
        console.log(`      Remote sync: ${chalk.green('up to date')}`);
      }
    }
    
    console.log('');
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
      // Still check git status if worktree path exists
      const gitStatus = host.worktreePath ? await this.getGitStatus(host.worktreePath) : undefined;
      return {
        ...host,
        isActive: false,
        gitStatus
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
    
    // Check git status if worktree path exists
    const gitStatus = host.worktreePath ? await this.getGitStatus(host.worktreePath) : undefined;
    
    return {
      ...host,
      isActive: !!activeUpstream,
      statusCode: activeUpstream?.statusCode,
      responseTime: activeUpstream?.responseTime || Date.now() - startTime,
      gitStatus
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

  async selectAndOpenHost(hosts: CaddyHost[], timeoutMs?: number): Promise<string> {
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
      const gitStatus = this.formatGitStatus(host.gitStatus);
      
      return {
        name: `${statusIcon} ${hostName} ${responseTime} ${upstream} ${gitStatus}`,
        value: host.url,
        short: host.name,
        searchText: host.name.toLowerCase(), // For search filtering
        disabled: false, // Allow selection of offline hosts too
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

    // Create the prompt
    const promptPromise = inquirer.prompt([
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

    // If timeout is specified, race the prompt against the timeout
    let result;
    if (timeoutMs) {
      const timeoutPromise = new Promise<{selectedUrl: string}>((resolve) => {
        setTimeout(() => {
          // Force close the prompt and resolve with refresh
          (promptPromise as any).ui?.close();
          resolve({ selectedUrl: 'REFRESH' });
        }, timeoutMs);
      });

      result = await Promise.race([promptPromise, timeoutPromise]);
    } else {
      result = await promptPromise;
    }

    const { selectedUrl } = result;

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
        // Show detailed information about the selected host
        console.log(chalk.bold(`\n  Selected: ${chalk.cyan(selectedHost.name)}`));
        console.log(`    URL: ${selectedHost.url}`);
        
        if (selectedHost.upstreams && selectedHost.upstreams.length > 0) {
          console.log(`    Backend: ${selectedHost.upstreams.join(', ')}`);
          console.log(`    Status: ${selectedHost.isActive ? chalk.green('Active') : chalk.red('Offline')}`);
          if (selectedHost.responseTime) {
            console.log(`    Response time: ${selectedHost.responseTime}ms`);
          }
        } else {
          console.log(`    Backend: ${chalk.gray('None configured')}`);
        }
        
        if (selectedHost.worktreePath) {
          console.log(`    Worktree: ${selectedHost.worktreePath}`);
          this.displayDetailedGitStatus(selectedHost.gitStatus);
        }
        
        // Ask how to open
        const openChoices = [
          { name: chalk.cyan('🌐 Open in browser'), value: 'browser' },
        ];
        
        if (selectedHost.worktreePath) {
          openChoices.push({ name: chalk.blue('📝 Open folder in VSCode'), value: 'vscode' });
        }
        
        if (selectedHost.gitStatus?.pullRequest?.url) {
          openChoices.push({ name: chalk.green('🔗 Open Pull Request'), value: 'pr' });
        }
        
        openChoices.push({ name: chalk.red('🗑️  Delete Caddy Route'), value: 'delete' });
        openChoices.push({ name: chalk.gray('← Back'), value: 'back' });
        
        // Create a promise that resolves when ESC is pressed or normal selection is made
        const { openMethod } = await new Promise<{openMethod: string}>((resolve) => {
          // Enable keypress events
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();
          
          const detailPrompt = inquirer.prompt([
            {
              type: 'list',
              name: 'openMethod',
              message: `How would you like to open ${chalk.cyan(selectedHost.name)}? ${chalk.gray('(ESC to go back)')}`,
              choices: openChoices
            }
          ]);

          // Handle normal selection
          detailPrompt.then((result) => {
            process.stdin.removeAllListeners('keypress');
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(false);
            }
            resolve(result);
          });

          // Handle ESC key
          const keyListener = (_str: string, key: any) => {
            if (key && key.name === 'escape') {
              // Close the prompt and resolve with back action
              (detailPrompt as any).ui.close();
              process.stdin.removeAllListeners('keypress');
              if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
              }
              resolve({ openMethod: 'back' });
            }
          };

          process.stdin.on('keypress', keyListener);
        });
        
        if (openMethod === 'browser') {
          console.log(chalk.green(`Opening ${selectedUrl} in browser...`));
          await open(selectedUrl);
        } else if (openMethod === 'vscode' && selectedHost.worktreePath) {
          console.log(chalk.blue(`Opening ${selectedHost.worktreePath} in VSCode...`));
          exec(`code "${selectedHost.worktreePath}"`, (error: any) => {
            if (error) {
              console.error(chalk.red(`Failed to open in VSCode: ${error.message}`));
            }
          });
          await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause
        } else if (openMethod === 'pr' && selectedHost.gitStatus?.pullRequest?.url) {
          console.log(chalk.green(`Opening PR #${selectedHost.gitStatus.pullRequest.number} in browser...`));
          await open(selectedHost.gitStatus.pullRequest.url);
        } else if (openMethod === 'delete') {
          // Show detailed information about what will be deleted
          console.log(chalk.yellow(`\n⚠️  You are about to delete the Caddy route for:`));
          console.log(`    Host: ${chalk.cyan(selectedHost.name)}`);
          console.log(`    URL: ${selectedHost.url}`);
          if (selectedHost.upstreams && selectedHost.upstreams.length > 0) {
            console.log(`    Backend: ${selectedHost.upstreams.join(', ')}`);
          }
          console.log(chalk.red(`\n    This will permanently remove this host from Caddy configuration!`));
          
          const { confirmDelete } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirmDelete',
              message: `Are you sure you want to delete the route for ${chalk.cyan(selectedHost.name)}?`,
              default: false
            }
          ]);

          if (confirmDelete) {
            const spinner = ora(`Deleting route for ${selectedHost.name}...`).start();
            
            try {
              const success = await this.deleteHostRoute(selectedHost);
              
              if (success) {
                spinner.succeed(`Successfully deleted route for ${selectedHost.name}`);
                console.log(chalk.green(`✓ Route for ${selectedHost.name} has been removed from Caddy configuration`));
                return 'refresh'; // Refresh the host list
              } else {
                spinner.fail(`Failed to delete route for ${selectedHost.name}`);
              }
            } catch (error) {
              spinner.fail('Failed to delete route');
              console.error(chalk.red((error as Error).message));
            }
          } else {
            console.log(chalk.gray('Route deletion cancelled'));
          }
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
          const gitStatus = this.formatGitStatus(host.gitStatus);
          console.log(`  ${chalk.green('●')} ${chalk.cyan(host.name.padEnd(40))} ${responseTime.padEnd(8)} ${upstream} ${gitStatus}`);
        }
      }
      
      if (inactiveHosts.length > 0) {
        console.log(chalk.red.bold('\n  Offline (backend unreachable):\n'));
        for (const host of inactiveHosts) {
          const upstream = host.upstreams && host.upstreams.length > 0 
            ? chalk.gray.dim(`→ ${host.upstreams.join(', ')}`)
            : chalk.gray.dim('→ (no upstream)');
          const gitStatus = this.formatGitStatus(host.gitStatus);
          console.log(`  ${chalk.red('●')} ${chalk.gray(host.name.padEnd(40))} ${upstream} ${gitStatus}`);
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
        const gitStatus = this.formatGitStatus(host.gitStatus);
        console.log(`  ${chalk.cyan(host.name.padEnd(40))} ${upstream} ${gitStatus}`);
      }
      console.log('');
    }
  }

  async deleteHostRoute(host: CaddyHost): Promise<boolean> {
    try {
      // Get current config
      const config = await this.fetchCaddyConfig();
      
      // Find the route to delete
      let routeFound = false;
      let deletedCount = 0;
      
      if (config.apps?.http?.servers) {
        for (const [serverName, server] of Object.entries(config.apps.http.servers)) {
          if (server.routes) {
            // Go through routes in reverse order to track indices for deletion
            for (let i = server.routes.length - 1; i >= 0; i--) {
              const route = server.routes[i];
              if (route.match) {
                for (const match of route.match) {
                  if (match.host && match.host.includes(host.name)) {
                    // Found the route for this host
                    routeFound = true;
                    try {
                      const path = `/config/apps/http/servers/${serverName}/routes/${i}`;
                      await axios.delete(`${this.caddyApiUrl}${path}`);
                      deletedCount++;
                      console.log(chalk.green(`✓ Deleted route for ${host.name} from server ${serverName}`));
                    } catch (err) {
                      console.error(chalk.red(`✗ Failed to delete route for ${host.name}: ${err}`));
                      return false;
                    }
                    break; // Found and processed this host's route
                  }
                }
                if (routeFound) break; // Exit route loop if we found and processed the route
              }
            }
            if (routeFound) break; // Exit server loop if we found and processed the route
          }
        }
      }

      if (!routeFound) {
        console.log(chalk.yellow(`No route found for ${host.name}`));
        return false;
      }

      return deletedCount > 0;
    } catch (error) {
      console.error(chalk.red('Failed to delete route from Caddy configuration'));
      if (axios.isAxiosError(error)) {
        console.error(chalk.red(`Error: ${error.message}`));
        if (error.response?.data) {
          console.error(chalk.red('Response:', JSON.stringify(error.response.data, null, 2)));
        }
      } else {
        console.error(chalk.red((error as Error).message));
      }
      return false;
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
        
        // Calculate remaining time until auto-refresh
        const timeSinceRefresh = Date.now() - lastRefresh;
        const timeUntilRefresh = Math.max(0, refreshInterval - timeSinceRefresh);
        
        const action = await this.selectAndOpenHost(hosts, timeUntilRefresh);
        
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