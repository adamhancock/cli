#!/usr/bin/env node
import { $, echo, chalk, fs, argv } from 'zx';
import { join, dirname, resolve } from 'path';
import { select, input } from '@inquirer/prompts';
import { homedir } from 'os';

$.verbose = false;

interface WorktreeConfig {
  vscode?: {
    args?: string[];
    command?: string;
    open?: boolean;  // Whether to open VS Code at all
  };
  worktree?: {
    prefix?: string;
    location?: string;  // Custom location pattern, e.g., "../worktrees/{prefix}-{branch}"
  };
  git?: {
    fetch?: boolean;  // Whether to fetch before creating worktree (default: true)
    remote?: string;  // Remote name (default: "origin")
    defaultBranch?: string;  // Default branch for new branches (default: "main")
    pushNewBranches?: boolean;  // Auto-push new branches (default: false)
  };
  env?: {
    copy?: boolean;  // Whether to copy env files (default: true)
    patterns?: string[];  // Patterns for env files (default: [".env*"])
    exclude?: string[];  // Patterns to exclude
  };
  packageManager?: {
    install?: boolean;  // Whether to auto-install (default: true)
    force?: 'npm' | 'yarn' | 'pnpm' | 'bun';  // Force specific package manager
    command?: string;  // Custom install command
  };
  hooks?: {
    postCreate?: string[];  // Commands to run after creation
  };
}

async function loadConfig(): Promise<WorktreeConfig> {
  const config: WorktreeConfig = {};
  
  // Look for config files in order of precedence
  const configPaths = [
    join(process.cwd(), '.worktreerc.json'),
    join(process.cwd(), '.worktreerc'),
    join(homedir(), '.worktreerc.json'),
    join(homedir(), '.worktreerc')
  ];
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const fileContent = fs.readFileSync(configPath, 'utf-8');
        const parsedConfig = JSON.parse(fileContent);
        Object.assign(config, parsedConfig);
        echo(chalk.gray(`Loaded config from: ${configPath}`));
        break;
      } catch (err) {
        echo(chalk.yellow(`Warning: Failed to parse config file ${configPath}`));
      }
    }
  }
  
  return config;
}

async function configureShell() {
  try {
    await $`which zsh`;
    $.shell = '/bin/zsh';
    echo(chalk.gray('Using zsh shell'));
  } catch {
    $.shell = '/bin/bash';
    echo(chalk.gray('Using bash shell (zsh not available)'));
  }
}

async function isGitRepository(): Promise<boolean> {
  try {
    await $`git rev-parse --git-dir`;
    return true;
  } catch {
    return false;
  }
}

async function getRemoteBranches(remote: string = 'origin'): Promise<string[]> {
  echo(chalk.blue('Fetching latest branches...'));
  await $`git fetch ${remote}`;
  
  const result = await $`git branch -r`;
  const branches = result.stdout
    .split('\n')
    .filter(line => line.trim() && !line.includes('HEAD'))
    .map(line => line.trim().replace(`${remote}/`, ''))
    .sort();
  
  return branches;
}

async function selectBranchInteractive(branches: string[]): Promise<string | null> {
  try {
    const CREATE_NEW = '+ Create new branch';
    const choices = [
      { name: CREATE_NEW, value: CREATE_NEW },
      ...branches.map(branch => ({
        name: branch,
        value: branch
      }))
    ];
    
    const selected = await select({
      message: 'Select a branch to create worktree:',
      choices
    });
    
    if (selected === CREATE_NEW) {
      const branchName = await input({
        message: 'Enter the new branch name:',
        validate: (value) => {
          if (!value.trim()) {
            return 'Branch name cannot be empty';
          }
          if (branches.includes(value)) {
            return 'Branch already exists';
          }
          return true;
        }
      });
      echo(chalk.green(`\nCreating new branch: ${branchName}`));
      return branchName;
    }
    
    echo(chalk.cyan(`\nSelected branch: ${selected}`));
    return selected;
  } catch (err) {
    echo('\nCancelled');
    return null;
  }
}

async function findEnvFiles(dir: string, patterns: string[] = ['.env*'], exclude: string[] = []): Promise<string[]> {
  let allFiles: string[] = [];
  
  // Execute find command for each pattern separately to avoid shell interpretation issues
  for (const pattern of patterns) {
    try {
      const result = await $`find ${dir} -name ${pattern} -type f`;
      const files = result.stdout.split('\n').filter(Boolean);
      allFiles.push(...files);
    } catch (err) {
      // Pattern might not match any files, that's ok
    }
  }
  
  // Remove duplicates
  allFiles = [...new Set(allFiles)];
  
  // Apply exclusions
  if (exclude.length > 0) {
    allFiles = allFiles.filter(file => {
      const filename = file.split('/').pop() || '';
      return !exclude.some(pattern => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(filename);
      });
    });
  }
  
  return allFiles;
}

async function branchExists(branchName: string, type: 'local' | 'remote', remote: string = 'origin'): Promise<boolean> {
  try {
    if (type === 'local') {
      await $`git show-ref --verify --quiet refs/heads/${branchName}`;
    } else {
      await $`git show-ref --verify --quiet refs/remotes/${remote}/${branchName}`;
    }
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(dir: string): Promise<string> {
  if (fs.existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(join(dir, 'package-lock.json'))) {
    return 'npm';
  }
  if (fs.existsSync(join(dir, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm'; // default
}

async function installDependencies(packageManager: string, workingDir?: string) {
  echo(chalk.blue(`Installing dependencies with ${packageManager}...`));
  
  const originalVerbose = $.verbose;
  const originalCwd = $.cwd;
  $.verbose = true; // Show command output
  
  try {
    if (workingDir) {
      $.cwd = workingDir;
    }
    
    await $`pwd`;
    switch (packageManager) {
      case 'pnpm':
        await $`pnpm install --frozen-lockfile`;
        break;
      case 'yarn':
        await $`yarn install --frozen-lockfile`;
        break;
      case 'bun':
        await $`bun install --frozen-lockfile`;
        break;
      case 'npm':
      default:
        await $`npm ci`;
        break;
    }
  } finally {
    $.verbose = originalVerbose; // Restore original verbose setting
    $.cwd = originalCwd; // Restore original working directory
  }
}



async function createWorktree(branchName?: string) {
  // Configure shell
  await configureShell();
  
  // Load configuration
  const config = await loadConfig();
  
  // Check if we're in a git repository
  if (!await isGitRepository()) {
    echo(chalk.red('Error: Not in a git repository'));
    process.exit(1);
  }

  let selectedBranch: string;

  const remote = config.git?.remote || 'origin';
  const defaultBranch = config.git?.defaultBranch || 'main';

  // If no branch provided, show interactive selector
  if (!branchName) {
    const branches = await getRemoteBranches(remote);
    
    if (branches.length === 0) {
      echo(chalk.red('No remote branches found'));
      process.exit(1);
    }

    const selected = await selectBranchInteractive(branches);
    if (!selected) {
      process.exit(0);
    }
    selectedBranch = selected;
  } else {
    selectedBranch = branchName;
  }

  // Replace forward slashes with hyphens for directory name
  const safeBranchName = selectedBranch.replace(/\//g, '-');
  const prefix = config.worktree?.prefix || 'assurix';
  
  // Use custom location pattern if provided
  let worktreePath: string;
  if (config.worktree?.location) {
    worktreePath = config.worktree.location
      .replace('{prefix}', prefix)
      .replace('{branch}', safeBranchName)
      .replace('{original-branch}', selectedBranch);
  } else {
    worktreePath = join('..', `${prefix}-${safeBranchName}`);
  }

  echo(chalk.cyan(`Creating worktree for branch: ${selectedBranch}`));
  echo(chalk.gray(`Worktree path: ${worktreePath}`));

  // Check if worktree directory already exists
  if (fs.existsSync(worktreePath)) {
    echo(chalk.red(`Error: Directory ${worktreePath} already exists`));
    process.exit(1);
  }

  // Store the original directory
  const originalDir = process.cwd();

  // Fetch latest from remote (skip if it would cause conflicts or disabled)
  if (config.git?.fetch !== false) {
    echo(chalk.blue(`Fetching latest from ${remote}...`));
    try {
      await $`git fetch ${remote}`;
    } catch (err) {
      echo(chalk.yellow(`Warning: Could not fetch from ${remote} (this is OK if ${defaultBranch} is checked out elsewhere)`));
    }
    
    // Pull the latest changes for the default branch
    echo(chalk.blue(`Pulling latest changes for ${defaultBranch} branch...`));
    try {
      // Get current branch
      const currentBranchResult = await $`git rev-parse --abbrev-ref HEAD`;
      const currentBranch = currentBranchResult.stdout.trim();
      
      if (currentBranch === defaultBranch) {
        // If we're on the default branch, just pull
        await $`git pull ${remote} ${defaultBranch}`;
      } else {
        // If we're on a different branch, fetch and update the default branch
        await $`git fetch ${remote} ${defaultBranch}:${defaultBranch}`;
      }
      echo(chalk.green(`Successfully updated ${defaultBranch} branch`));
    } catch (err) {
      echo(chalk.yellow(`Warning: Could not pull latest changes for ${defaultBranch}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Create the worktree with the appropriate branch
  try {
    if (await branchExists(selectedBranch, 'local', remote)) {
      echo(chalk.blue(`Creating worktree with existing local branch: ${selectedBranch}`));
      await $`git worktree add ${worktreePath} ${selectedBranch}`;
    } else if (await branchExists(selectedBranch, 'remote', remote)) {
      echo(chalk.blue(`Creating worktree from remote branch: ${selectedBranch}`));
      await $`git worktree add ${worktreePath} -b ${selectedBranch} ${remote}/${selectedBranch}`;
    } else {
      echo(chalk.blue(`Creating worktree with new branch: ${selectedBranch}`));
      // Create new branch from remote/defaultBranch to avoid checkout conflicts
      await $`git worktree add ${worktreePath} -b ${selectedBranch} ${remote}/${defaultBranch}`;
    }
  } catch (err) {
    echo(chalk.red(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Get absolute path and change to the worktree directory
  const absoluteWorktreePath = resolve(originalDir, worktreePath);
  process.chdir(absoluteWorktreePath);
  
  // Wait a moment for git to settle after worktree creation
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Set up branch tracking for the worktree
  try {
    if (await branchExists(selectedBranch, 'remote', remote)) {
      // For existing remote branches, ensure tracking is set
      echo(chalk.blue(`Setting upstream for ${selectedBranch} to track ${remote}/${selectedBranch}`));
      await $`git branch --set-upstream-to=${remote}/${selectedBranch} ${selectedBranch}`;
    } else {
      // For new branches, set up push configuration
      echo(chalk.blue(`New branch ${selectedBranch} created locally. Configuring to push to ${remote}/${selectedBranch}`));
      await $`git config branch.${selectedBranch}.remote ${remote}`;
      await $`git config branch.${selectedBranch}.merge refs/heads/${selectedBranch}`;
      await $`git config push.default simple`;
      
      // Auto-push new branches if configured
      if (config.git?.pushNewBranches) {
        echo(chalk.blue(`Pushing new branch to ${remote}...`));
        try {
          await $`git push -u ${remote} ${selectedBranch}`;
          echo(chalk.green(`Successfully pushed ${selectedBranch} to ${remote}`));
        } catch (err) {
          echo(chalk.yellow(`Warning: Could not push new branch: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    }
  } catch (err) {
    echo(chalk.yellow(`Warning: Could not set upstream tracking: ${err instanceof Error ? err.message : String(err)}`));
  }
  
  // Stay in the worktree directory for subsequent operations

  // Navigate to the new worktree (already changed during upstream setup)
  // No need to change directory again

  // Copy .env files from the original directory
  if (config.env?.copy !== false) {
    echo(chalk.blue('Copying .env files...'));
    const patterns = config.env?.patterns || ['.env*'];
    const exclude = config.env?.exclude || [];
    const envFiles = await findEnvFiles(originalDir, patterns, exclude);
    
    for (const envFile of envFiles) {
      const relativePath = envFile.replace(originalDir + '/', '');
      const targetPath = join(process.cwd(), relativePath);
      const targetDir = dirname(targetPath);
      
      // Create directory structure if it doesn't exist
      await $`mkdir -p ${targetDir}`;
      
      // Copy the file (we're already in the worktree directory)
      await $`cp ${envFile} ${targetPath}`;
      echo(chalk.green(`Copied: ${relativePath}`));
    }
  } else {
    echo(chalk.gray('Skipping .env file copying (disabled in config)'));
  }

  // Detect package manager and install dependencies
  if (config.packageManager?.install !== false) {
    echo(chalk.gray(`Current directory: ${process.cwd()}`));
    const packageManager = config.packageManager?.force || await detectPackageManager(process.cwd());
    
    if (config.packageManager?.command) {
      echo(chalk.blue(`Running custom install command: ${config.packageManager.command}`));
      const originalVerbose = $.verbose;
      $.verbose = true;
      try {
        await $`${config.packageManager.command.split(' ')}`;
      } finally {
        $.verbose = originalVerbose;
      }
    } else {
      await installDependencies(packageManager, process.cwd());
    }
  } else {
    echo(chalk.gray('Skipping dependency installation (disabled in config)'));
  }

  // Run post-create hooks
  if (config.hooks?.postCreate && config.hooks.postCreate.length > 0) {
    echo(chalk.blue('Running post-create hooks...'));
    echo(chalk.gray(`Working directory: ${process.cwd()}`));
    
    // Verify we're in the correct worktree
    const currentBranch = await $`git rev-parse --abbrev-ref HEAD`;
    echo(chalk.gray(`Current branch: ${currentBranch.stdout.trim()}`));
    
    const originalVerbose = $.verbose;
    $.verbose = true; // Show hook command output
    
    // Prepare template variables for replacement
    const templateVars: Record<string, string> = {
      branch: selectedBranch,
      safeBranch: safeBranchName,
      worktreePath: absoluteWorktreePath,
      originalDir: originalDir,
      prefix: prefix,
      remote: remote,
      defaultBranch: defaultBranch
    };
    
    for (const hook of config.hooks.postCreate) {
      // Replace template variables in the hook command
      let expandedHook = hook;
      for (const [key, value] of Object.entries(templateVars)) {
        expandedHook = expandedHook.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
      
      echo(chalk.gray(`Running: ${expandedHook}`));
      echo(chalk.gray(`Running in directory: ${process.cwd()}`));
      try {
        // Ensure we're in the worktree directory and use cd to explicitly set the directory for the eval
        await $`cd ${absoluteWorktreePath} && eval ${expandedHook}`;
      } catch (err) {
        echo(chalk.yellow(`Warning: Hook failed: ${expandedHook}`));
        echo(chalk.yellow(`Error: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    
    $.verbose = originalVerbose; // Restore original verbose setting
  }

  // Open in VS Code (after hooks have completed)
  if (config.vscode?.open !== false) {
    const absoluteWorktreePath = resolve(originalDir, worktreePath);
    echo(chalk.blue(`Opening VS Code at: ${absoluteWorktreePath}`));
    try {
      const vscodeCommand = config.vscode?.command || 'code';
      const vscodeArgs = config.vscode?.args || [];
      const command = [vscodeCommand, ...vscodeArgs, absoluteWorktreePath];
      
      await $`${command}`;
    } catch (err) {
      echo(chalk.yellow('Failed to open VS Code. You can manually open the project at:'), absoluteWorktreePath);
    }
  }

  echo(chalk.green('✅ Worktree created successfully!'));
  echo(chalk.cyan(`📁 Location: ${worktreePath}`));
  echo(chalk.cyan(`🌿 Branch: ${selectedBranch}`));
}

// Main execution
const branchName = argv._[0];
createWorktree(branchName).catch(err => {
  echo(chalk.red('Error:'), err.message);
  process.exit(1);
});