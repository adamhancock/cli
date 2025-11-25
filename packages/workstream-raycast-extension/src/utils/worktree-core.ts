import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import type {
  WorktreeRcConfig,
  TemplateVariables,
} from '../types/worktree-config';

const execAsync = promisify(exec);

// Compute home directory paths once at module initialization to avoid runtime issues
// This prevents "homedir is not defined" errors in certain execution contexts
const HOME_DIR = homedir();
const USER_PATHS = [
  '/opt/homebrew/bin',          // Apple Silicon Homebrew
  '/usr/local/bin',              // Intel Homebrew
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  join(HOME_DIR, '.local/bin'), // User local binaries
  join(HOME_DIR, '.npm-global/bin'), // npm global
  join(HOME_DIR, '.yarn/bin'),  // yarn global
  join(HOME_DIR, '.config/yarn/global/node_modules/.bin'), // yarn v2+
  join(HOME_DIR, '.pnpm'),      // pnpm home
  join(HOME_DIR, 'Library/pnpm'), // pnpm on macOS
  join(HOME_DIR, '.nvm/versions/node/v22.17.0/bin'), // NVM paths
  join(HOME_DIR, '.nvm/versions/node/v20.0.0/bin'),
  join(HOME_DIR, '.nvm/versions/node/v18.0.0/bin'),
  join(HOME_DIR, '.nvm/current/bin'), // Generic NVM current
];
const NVM_DIR = join(HOME_DIR, '.nvm');

/**
 * Execute a shell command in a specific directory with targeted retry logic
 * Only retries on specific transient filesystem race conditions
 */
async function execInDirWithRetry(
  command: string,
  cwd: string,
  maxRetries: number = 1,
  retryDelay: number = 300,
  onOutput?: OutputCallback
): Promise<{ stdout: string; stderr: string }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Wait before retrying
        onOutput?.(`Retrying command (attempt ${attempt + 1}/${maxRetries + 1})...`, 'warning');
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
      return await execInDir(command, cwd);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on specific transient race condition errors that might still occur
      // despite our proactive cleanup (e.g., filesystem delays, NFS issues)
      const isTransientError =
        lastError.message.includes('cannot create directory') ||
        lastError.message.includes('No such file or directory') ||
        lastError.message.includes('already exists');

      const shouldRetry = isTransientError && attempt < maxRetries;

      if (shouldRetry) {
        onOutput?.(`Transient filesystem error detected, will retry: ${lastError.message}`, 'warning');
        continue;
      }

      // Don't retry on other errors (permissions, invalid refs, git config issues, etc.)
      throw lastError;
    }
  }

  throw lastError || new Error('Command failed after all retry attempts');
}

/**
 * Execute a shell command in a specific directory
 */
async function execInDir(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  // Build a comprehensive PATH that includes common package manager locations
  const paths = [...USER_PATHS];

  // Add existing PATH
  if (process.env.PATH) {
    paths.push(process.env.PATH);
  }

  return execAsync(command, {
    cwd,
    shell: '/bin/zsh',
    env: {
      ...process.env,
      PATH: paths.join(':'),
      NVM_DIR: NVM_DIR,
    },
  });
}

/**
 * Callback for streaming output during worktree creation
 */
export type OutputCallback = (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  /**
   * Branch name to create worktree for
   */
  branchName: string;

  /**
   * Path to the git repository
   */
  repoPath: string;

  /**
   * Optional configuration override (uses .worktreerc.json if not provided)
   */
  config?: WorktreeRcConfig;

  /**
   * Optional base branch to create from (defaults to defaultBranch from config or 'main')
   */
  baseBranch?: string;

  /**
   * Callback for streaming output messages
   */
  onOutput?: OutputCallback;

  /**
   * Skip opening VS Code after creation
   */
  skipVSCode?: boolean;

  /**
   * Force remove existing directory and recreate
   */
  force?: boolean;
}

/**
 * Result of worktree creation
 */
export interface CreateWorktreeResult {
  success: boolean;
  worktreePath?: string;
  error?: string;
}

/**
 * Load worktree configuration from .worktreerc.json or .worktreerc files
 */
export async function loadConfig(repoPath: string): Promise<WorktreeRcConfig> {
  const config: WorktreeRcConfig = {};

  // Look for config files in order of precedence
  const configPaths = [
    join(repoPath, '.worktreerc.json'),
    join(repoPath, '.worktreerc'),
    join(HOME_DIR, '.worktreerc.json'),
    join(HOME_DIR, '.worktreerc'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const fileContent = readFileSync(configPath, 'utf-8');
        const parsedConfig = JSON.parse(fileContent);
        Object.assign(config, parsedConfig);
        break;
      } catch (err) {
        // Failed to parse config, continue to next file
      }
    }
  }

  return config;
}

/**
 * Check if a directory is a git repository
 */
async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execInDir('git rev-parse --git-dir', repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists locally or remotely
 */
async function branchExists(
  repoPath: string,
  branchName: string,
  type: 'local' | 'remote',
  remote: string = 'origin'
): Promise<boolean> {
  try {
    if (type === 'local') {
      await execInDir(`git show-ref --verify --quiet refs/heads/${branchName}`, repoPath);
    } else {
      await execInDir(`git show-ref --verify --quiet refs/remotes/${remote}/${branchName}`, repoPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find environment files matching patterns
 */
async function findEnvFiles(
  dir: string,
  patterns: string[] = ['.env*'],
  exclude: string[] = []
): Promise<string[]> {
  let allFiles: string[] = [];

  // Execute find command for each pattern
  for (const pattern of patterns) {
    try {
      const { stdout } = await execInDir(`find . -name "${pattern}" -type f`, dir);
      const files = stdout
        .split('\n')
        .filter(Boolean)
        .map((f) => join(dir, f.replace(/^\.\//, '')));
      allFiles.push(...files);
    } catch (err) {
      // Pattern might not match any files, that's ok
    }
  }

  // Remove duplicates
  allFiles = [...new Set(allFiles)];

  // Apply exclusions
  if (exclude.length > 0) {
    allFiles = allFiles.filter((file) => {
      const filename = file.split('/').pop() || '';
      return !exclude.some((pattern) => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(filename);
      });
    });
  }

  return allFiles;
}

/**
 * Detect package manager based on lockfiles
 */
function detectPackageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(dir, 'package-lock.json'))) {
    return 'npm';
  }
  if (existsSync(join(dir, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm'; // default
}

/**
 * Install dependencies using the detected package manager
 */
async function installDependencies(
  packageManager: string,
  workingDir: string,
  onOutput?: OutputCallback
): Promise<void> {
  onOutput?.(`Installing dependencies with ${packageManager}...`, 'info');

  let command: string;
  switch (packageManager) {
    case 'pnpm':
      command = 'pnpm install --frozen-lockfile';
      break;
    case 'yarn':
      command = 'yarn install --frozen-lockfile';
      break;
    case 'bun':
      command = 'bun install --frozen-lockfile';
      break;
    case 'npm':
    default:
      command = 'npm ci';
      break;
  }

  await execInDir(command, workingDir);
}

/**
 * Execute post-create hooks with template variable substitution
 */
async function executePostCreateHooks(
  hooks: string[],
  templateVars: TemplateVariables,
  onOutput?: OutputCallback
): Promise<void> {
  onOutput?.('Running post-create hooks...', 'info');

  for (const hook of hooks) {
    // Replace template variables in the hook command
    let expandedHook = hook;
    for (const [key, value] of Object.entries(templateVars)) {
      expandedHook = expandedHook.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    onOutput?.(`Running: ${expandedHook}`, 'info');

    try {
      await execInDir(expandedHook, templateVars.worktreePath);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onOutput?.(`Warning: Hook failed: ${errorMsg}`, 'warning');
    }
  }
}

/**
 * Create a git worktree with full environment setup
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  const { branchName, repoPath, config: providedConfig, baseBranch: providedBaseBranch, onOutput, skipVSCode } = options;

  try {
    // Load configuration
    const config = providedConfig || (await loadConfig(repoPath));

    // Override VS Code open setting if skipVSCode is true
    if (skipVSCode) {
      config.vscode = { ...config.vscode, open: false };
    }

    // Check if we're in a git repository
    if (!(await isGitRepository(repoPath))) {
      throw new Error('Not in a git repository');
    }

    const remote = config.git?.remote || 'origin';
    const defaultBranch = config.git?.defaultBranch || 'main';
    const baseBranch = providedBaseBranch || defaultBranch; // Use provided baseBranch or fall back to defaultBranch
    const selectedBranch = branchName;

    onOutput?.(`Creating worktree for branch: ${selectedBranch}`, 'info');

    // Replace forward slashes with hyphens for directory name
    const safeBranchName = selectedBranch.replace(/\//g, '-');
    const prefix = config.worktree?.prefix || '';

    // Get repo name from path
    const repoName = repoPath.split('/').pop() || '';

    // Determine worktree path
    let worktreePath: string;
    if (config.worktree?.location) {
      worktreePath = config.worktree.location
        .replace('{prefix}', prefix)
        .replace('{branch}', safeBranchName)
        .replace('{original-branch}', selectedBranch)
        .replace('{repo}', repoName);
    } else {
      // Default: ../reponame-branch
      worktreePath = join('..', `${repoName}-${safeBranchName}`);
    }

    // Resolve to absolute path
    const absoluteWorktreePath = resolve(repoPath, worktreePath);
    onOutput?.(`Worktree path: ${absoluteWorktreePath}`, 'info');

    // Prune any stale worktree entries from git's registry
    // This prevents issues with lingering references from previously failed operations
    try {
      onOutput?.('Pruning stale worktree entries...', 'info');
      await execInDir('git worktree prune', repoPath);
    } catch (err) {
      // Prune failure is not critical, continue
      onOutput?.('Warning: Could not prune worktrees', 'warning');
    }

    // Check if worktree already exists and handle based on force option
    if (existsSync(absoluteWorktreePath) && !options.force) {
      throw new Error(`Directory ${absoluteWorktreePath} already exists. Use force option to recreate.`);
    }

    // Ensure parent directory exists
    const parentDir = dirname(absoluteWorktreePath);
    if (!existsSync(parentDir)) {
      onOutput?.(`Creating parent directory: ${parentDir}`, 'info');
      await execAsync(`mkdir -p "${parentDir}"`);
    }

    // Fetch latest from remote (skip if disabled)
    if (config.git?.fetch !== false) {
      onOutput?.(`Fetching latest from ${remote}...`, 'info');
      try {
        await execInDir(`git fetch ${remote}`, repoPath);
        onOutput?.(`Successfully fetched from ${remote}`, 'success');
      } catch (err) {
        onOutput?.(`Warning: Could not fetch from ${remote}`, 'warning');
      }

      // Pull the latest changes for the default branch
      onOutput?.(`Pulling latest changes for ${defaultBranch} branch...`, 'info');
      try {
        const currentBranchResult = await execInDir('git rev-parse --abbrev-ref HEAD', repoPath);
        const currentBranch = currentBranchResult.stdout.trim();

        if (currentBranch === defaultBranch) {
          // Set pull strategy to avoid divergent branch errors
          await execInDir('git config pull.rebase false', repoPath);
          await execInDir(`git pull ${remote} ${defaultBranch}`, repoPath);
        } else {
          // Not on default branch, just update the ref
          await execInDir(`git fetch ${remote} ${defaultBranch}:${defaultBranch}`, repoPath);
        }
        onOutput?.(`Successfully updated ${defaultBranch} branch`, 'success');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onOutput?.(`Warning: Could not pull latest changes for ${defaultBranch}: ${errorMsg}`, 'warning');
        // Not critical, continue anyway
      }
    }

    // Proactively remove the target directory immediately before git worktree add
    // This is the most reliable way to prevent EEXIST errors and .claude directory issues
    // The 'force: true' option prevents an error if the path doesn't exist
    onOutput?.('Ensuring clean worktree path...', 'info');
    try {
      await fs.rm(absoluteWorktreePath, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onOutput?.(`Warning: Could not clean worktree path: ${errorMsg}`, 'warning');
      // Continue anyway - fs.rm with force:true should not throw
    }

    // Also ensure git's registry is clean
    try {
      await execInDir(`git worktree remove "${absoluteWorktreePath}" --force`, repoPath);
    } catch (err) {
      // Expected to fail if worktree doesn't exist in registry - this is fine
    }

    // Final prune to ensure registry is clean
    try {
      await execInDir('git worktree prune', repoPath);
    } catch (err) {
      // Not critical
    }

    // Create the worktree with the appropriate branch
    const localExists = await branchExists(repoPath, selectedBranch, 'local', remote);
    const remoteExists = await branchExists(repoPath, selectedBranch, 'remote', remote);

    try {
      if (localExists) {
        onOutput?.(`Creating worktree with existing local branch: ${selectedBranch}`, 'info');
        await execInDirWithRetry(`git worktree add "${absoluteWorktreePath}" ${selectedBranch}`, repoPath, 1, 300, onOutput);
      } else if (remoteExists) {
        onOutput?.(`Creating worktree from remote branch: ${selectedBranch}`, 'info');
        await execInDirWithRetry(`git worktree add "${absoluteWorktreePath}" -b ${selectedBranch} ${remote}/${selectedBranch}`, repoPath, 1, 300, onOutput);
      } else {
        onOutput?.(`Creating worktree with new branch: ${selectedBranch} from ${baseBranch}`, 'info');
        await execInDirWithRetry(`git worktree add "${absoluteWorktreePath}" -b ${selectedBranch} ${remote}/${baseBranch}`, repoPath, 1, 300, onOutput);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create worktree at ${absoluteWorktreePath}: ${errorMsg}`);
    }

    // Worktree created successfully - no artificial delay needed with deterministic cleanup

    // Set up branch tracking
    try {
      if (remoteExists) {
        onOutput?.(`Setting upstream for ${selectedBranch} to track ${remote}/${selectedBranch}`, 'info');
        await execInDir(`git branch --set-upstream-to=${remote}/${selectedBranch} ${selectedBranch}`, absoluteWorktreePath);
      } else {
        onOutput?.(
          `New branch ${selectedBranch} created locally. Configuring to push to ${remote}/${selectedBranch}`,
          'info'
        );
        await execInDir(`git config branch.${selectedBranch}.remote ${remote}`, absoluteWorktreePath);
        await execInDir(`git config branch.${selectedBranch}.merge refs/heads/${selectedBranch}`, absoluteWorktreePath);
        await execInDir('git config push.default simple', absoluteWorktreePath);

        // Auto-push new branches if configured
        if (config.git?.pushNewBranches) {
          onOutput?.(`Pushing new branch to ${remote}...`, 'info');
          try {
            await execInDir(`git push -u ${remote} ${selectedBranch}`, absoluteWorktreePath);
            onOutput?.(`Successfully pushed ${selectedBranch} to ${remote}`, 'success');
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            onOutput?.(`Warning: Could not push new branch: ${errorMsg}`, 'warning');
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onOutput?.(`Warning: Could not set upstream tracking: ${errorMsg}`, 'warning');
    }

    // Copy .env files
    if (config.env?.copy !== false) {
      onOutput?.('Copying .env files...', 'info');
      const patterns = config.env?.patterns || ['.env*'];
      const exclude = config.env?.exclude || [];
      const envFiles = await findEnvFiles(repoPath, patterns, exclude);

      for (const envFile of envFiles) {
        const relativePath = envFile.replace(repoPath + '/', '');
        const targetPath = join(absoluteWorktreePath, relativePath);
        const targetDir = dirname(targetPath);

        // Create directory structure if it doesn't exist
        await execAsync(`mkdir -p "${targetDir}"`);

        // Copy the file
        await execAsync(`cp "${envFile}" "${targetPath}"`);
        onOutput?.(`Copied: ${relativePath}`, 'success');
      }
    }

    // Install dependencies
    if (config.packageManager?.install !== false) {
      const packageManager = config.packageManager?.force || detectPackageManager(absoluteWorktreePath);

      if (config.packageManager?.command) {
        onOutput?.(`Running custom install command: ${config.packageManager.command}`, 'info');
        await execInDir(config.packageManager.command, absoluteWorktreePath);
      } else {
        await installDependencies(packageManager, absoluteWorktreePath, onOutput);
      }
    }

    // Run post-create hooks
    if (config.hooks?.postCreate && config.hooks.postCreate.length > 0) {
      const templateVars: TemplateVariables = {
        branch: selectedBranch,
        safeBranch: safeBranchName,
        worktreePath: absoluteWorktreePath,
        originalDir: repoPath,
        prefix: prefix,
        remote: remote,
        defaultBranch: defaultBranch,
        repo: repoName,
      };

      await executePostCreateHooks(config.hooks.postCreate, templateVars, onOutput);
    }

    // Open in VS Code
    if (config.vscode?.open !== false) {
      onOutput?.(`Opening VS Code at: ${absoluteWorktreePath}`, 'info');
      try {
        const vscodeCommand = config.vscode?.command || 'code';
        const vscodeArgs = config.vscode?.args || [];
        const command = `${vscodeCommand} ${vscodeArgs.join(' ')} "${absoluteWorktreePath}"`;

        await execAsync(command);
      } catch (err) {
        onOutput?.('Failed to open VS Code', 'warning');
      }
    }

    onOutput?.('✅ Worktree created successfully!', 'success');
    onOutput?.(`📁 Location: ${absoluteWorktreePath}`, 'info');
    onOutput?.(`🌿 Branch: ${selectedBranch}`, 'info');

    return {
      success: true,
      worktreePath: absoluteWorktreePath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    onOutput?.(errorMsg, 'error');

    return {
      success: false,
      error: errorMsg,
    };
  }
}
