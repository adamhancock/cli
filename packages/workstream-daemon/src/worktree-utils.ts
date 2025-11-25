import { $ } from 'zx';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { homedir } from 'os';

$.verbose = false;

/**
 * Detect the package manager used in a project by checking lock files
 * Returns the package manager command or null if not a JS/TS project
 */
function detectPackageManager(projectPath: string): 'pnpm' | 'yarn' | 'npm' | 'bun' | null {
  // Check for lock files in order of preference
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(projectPath, 'bun.lockb')) || existsSync(join(projectPath, 'bun.lock'))) {
    return 'bun';
  }
  if (existsSync(join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  // If there's a package.json but no lock file, default to npm
  if (existsSync(join(projectPath, 'package.json'))) {
    return 'npm';
  }
  return null;
}

/**
 * Run package manager install in the worktree directory
 */
async function runPackageManagerInstall(
  worktreePath: string,
  onOutput?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
): Promise<void> {
  const packageManager = detectPackageManager(worktreePath);
  
  if (!packageManager) {
    onOutput?.('No package.json detected, skipping dependency installation', 'info');
    return;
  }
  
  onOutput?.(`Detected ${packageManager}, installing dependencies...`, 'info');
  
  // Build enhanced environment with comprehensive PATH
  const enhancedEnv = buildEnhancedEnv();
  const originalEnv = $.env;
  
  try {
    $.env = enhancedEnv;
    
    // Run install command
    const installCmd = packageManager === 'yarn' ? 'yarn install' : `${packageManager} install`;
    onOutput?.(`Running: ${installCmd}`, 'info');
    
    await $`bash -c ${`cd "${worktreePath}" && ${installCmd}`}`;
    
    onOutput?.(`Dependencies installed successfully with ${packageManager}`, 'success');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    onOutput?.(`Warning: Failed to install dependencies: ${errorMsg}`, 'warning');
    // Don't throw - we want to continue even if install fails
  } finally {
    $.env = originalEnv;
  }
}

// Compute home directory paths once at module initialization to avoid runtime issues
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

interface CreateWorktreeOptions {
  branchName: string;
  repoPath: string;
  baseBranch?: string;
  force?: boolean;
  onOutput?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface CreateWorktreeResult {
  success: boolean;
  worktreePath?: string;
  error?: string;
}

interface WorktreeConfig {
  worktree?: {
    prefix?: string;
    location?: string;
  };
  git?: {
    remote?: string;
    defaultBranch?: string;
    fetch?: boolean;
  };
  hooks?: {
    postCreate?: string[];
  };
}

interface TemplateVariables {
  repo: string;
  branch: string;
  safeBranch: string;
  worktreePath: string;
  originalDir: string;
  prefix: string;
  remote: string;
  defaultBranch: string;
}

/**
 * Load worktree configuration from .worktreerc.json
 */
async function loadConfig(repoPath: string): Promise<WorktreeConfig> {
  const configPath = join(repoPath, '.worktreerc.json');

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Failed to load .worktreerc.json:', error);
    }
  }

  return {
    git: {
      remote: 'origin',
      defaultBranch: 'main',
      fetch: true,
    },
  };
}

/**
 * Check if directory is a git repository
 */
async function isGitRepository(path: string): Promise<boolean> {
  try {
    await $`git -C ${path} rev-parse --git-dir`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an enhanced environment with comprehensive PATH for executing hooks
 */
function buildEnhancedEnv(): Record<string, string> {
  // Build a comprehensive PATH that includes common package manager locations
  const paths = [...USER_PATHS];

  // Add existing PATH
  if (process.env.PATH) {
    paths.push(process.env.PATH);
  }

  return {
    ...process.env,
    PATH: paths.join(':'),
    NVM_DIR: NVM_DIR,
  };
}

/**
 * Execute post-create hooks with template variable substitution
 */
async function executePostCreateHooks(
  hooks: string[],
  templateVars: TemplateVariables,
  onOutput?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
): Promise<void> {
  onOutput?.('Running post-create hooks...', 'info');

  // Build enhanced environment with comprehensive PATH
  const enhancedEnv = buildEnhancedEnv();
  const originalEnv = $.env;

  try {
    // Configure zx to use enhanced environment
    $.env = enhancedEnv;

    for (const hook of hooks) {
      // Replace template variables in the hook command
      let expandedHook = hook;
      for (const [key, value] of Object.entries(templateVars)) {
        expandedHook = expandedHook.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }

      onOutput?.(`Running: ${expandedHook}`, 'info');

      try {
        // Use bash -c to properly parse the hook command as a shell command
        // This allows hooks like "devctl setup" to work correctly
        await $`bash -c ${`cd "${templateVars.worktreePath}" && ${expandedHook}`}`;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onOutput?.(`Warning: Hook failed: ${errorMsg}`, 'warning');
      }
    }

    onOutput?.('Post-create hooks completed', 'success');
  } finally {
    // Restore original environment
    $.env = originalEnv;
  }
}

/**
 * Create a worktree for a branch
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  const { branchName, repoPath, baseBranch: providedBaseBranch, force, onOutput } = options;

  try {
    // Load configuration
    const config = await loadConfig(repoPath);

    // Check if we're in a git repository
    if (!(await isGitRepository(repoPath))) {
      throw new Error('Not in a git repository');
    }

    const remote = config.git?.remote || 'origin';
    const defaultBranch = config.git?.defaultBranch || 'main';
    const baseBranch = providedBaseBranch || defaultBranch;

    onOutput?.(`Creating worktree for branch: ${branchName}`, 'info');

    // Replace forward slashes with hyphens for directory name
    const safeBranchName = branchName.replace(/\//g, '-');
    const prefix = config.worktree?.prefix || '';

    // Get repo name from path
    const repoName = repoPath.split('/').pop() || '';

    // Determine worktree path
    let worktreePath: string;
    if (config.worktree?.location) {
      worktreePath = config.worktree.location
        .replace('{prefix}', prefix)
        .replace('{branch}', safeBranchName)
        .replace('{original-branch}', branchName)
        .replace('{repo}', repoName);
    } else {
      // Default: ../reponame-branch
      worktreePath = join('..', `${repoName}-${safeBranchName}`);
    }

    // Resolve to absolute path
    const absoluteWorktreePath = resolve(repoPath, worktreePath);
    onOutput?.(`Worktree path: ${absoluteWorktreePath}`, 'info');

    // Comprehensive cleanup: prune stale worktrees, remove directory, and clean branch refs
    try {
      onOutput?.('Pruning stale worktree entries...', 'info');
      await $`git -C ${repoPath} worktree prune`;
    } catch (err) {
      onOutput?.('Warning: Could not prune worktrees', 'warning');
    }

    // Check if worktree already exists and clean it up
    if (existsSync(absoluteWorktreePath)) {
      // Always try to clean up existing directories to handle failed previous attempts
      onOutput?.(`Removing existing worktree at ${absoluteWorktreePath}...`, 'info');

      // Try to remove from git's worktree list first
      try {
        await $`git -C ${repoPath} worktree remove ${absoluteWorktreePath} --force`;
        onOutput?.('Git worktree removed successfully', 'info');
      } catch (error) {
        onOutput?.(`Git worktree remove failed (continuing): ${error}`, 'warning');
      }

      // Always try filesystem removal to be sure
      if (existsSync(absoluteWorktreePath)) {
        onOutput?.('Removing directory from filesystem...', 'info');
        try {
          await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
        } catch (error) {
          onOutput?.(`Filesystem removal failed: ${error}`, 'warning');
        }
      }

      // Verify directory is actually gone
      if (existsSync(absoluteWorktreePath)) {
        // Wait a moment and try one more time
        onOutput?.('Directory still exists, retrying removal...', 'warning');
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
          await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
        } catch (error) {
          // Final verification
          if (existsSync(absoluteWorktreePath)) {
            throw new Error(`Failed to remove existing directory at ${absoluteWorktreePath}. Please remove it manually or check permissions.`);
          }
        }
      }

      // Final verification
      if (existsSync(absoluteWorktreePath)) {
        throw new Error(`Directory ${absoluteWorktreePath} still exists after removal attempts. Cannot proceed.`);
      }

      onOutput?.('Existing worktree removed successfully', 'success');
    }
    
    // Also clean up any orphaned branch refs that might exist from failed attempts
    try {
      // Check if branch exists without a worktree
      const branchCheck = await $`git -C ${repoPath} show-ref --verify refs/heads/${branchName}`.catch(() => null);
      if (branchCheck) {
        // Branch exists - check if it has a worktree
        const worktreeList = await $`git -C ${repoPath} worktree list`;
        const hasWorktree = worktreeList.stdout.includes(branchName);
        
        if (!hasWorktree) {
          // Orphaned branch - remove it
          onOutput?.(`Removing orphaned branch ref: ${branchName}`, 'info');
          await $`git -C ${repoPath} branch -D ${branchName}`.catch(() => {});
        }
      }
    } catch (error) {
      // Not critical, continue
      onOutput?.('Branch cleanup check skipped', 'info');
    }

    // Ensure parent directory exists
    const parentDir = dirname(absoluteWorktreePath);
    if (!existsSync(parentDir)) {
      onOutput?.(`Creating parent directory: ${parentDir}`, 'info');
      await fs.mkdir(parentDir, { recursive: true });
    }

    // Fetch latest from remote
    if (config.git?.fetch !== false) {
      onOutput?.(`Fetching latest from ${remote}...`, 'info');
      try {
        await $`git -C ${repoPath} fetch ${remote}`;
        onOutput?.(`Successfully fetched from ${remote}`, 'success');
      } catch (err) {
        onOutput?.(`Warning: Could not fetch from ${remote}`, 'warning');
      }
    }

    // Check if branch exists locally or remotely
    let localBranchExists = false;
    let remoteBranchExists = false;

    try {
      const result = await $`git -C ${repoPath} show-ref --verify refs/heads/${branchName}`;
      localBranchExists = true;
      onOutput?.(`Local branch ref found for ${branchName}`, 'info');
    } catch {
      // Branch doesn't exist locally
    }

    try {
      const result = await $`git -C ${repoPath} show-ref --verify refs/remotes/${remote}/${branchName}`;
      remoteBranchExists = true;
      onOutput?.(`Remote branch ref found for ${branchName}`, 'info');
    } catch {
      // Branch doesn't exist remotely
    }

    // If neither exists, don't try to clean up - let git handle any stale refs during worktree creation
    if (!localBranchExists && !remoteBranchExists) {
      onOutput?.('Branch does not exist locally or remotely, will create new branch', 'info');
    }

    // Create worktree
    if (localBranchExists) {
      onOutput?.(`Branch ${branchName} exists locally, checking it out...`, 'info');
      await $`git -C ${repoPath} worktree add ${absoluteWorktreePath} ${branchName}`;
    } else if (remoteBranchExists) {
      onOutput?.(`Branch ${branchName} exists remotely, checking it out...`, 'info');
      await $`git -C ${repoPath} worktree add ${absoluteWorktreePath} ${branchName}`;
    } else {
      onOutput?.(`Branch ${branchName} does not exist, creating from ${baseBranch}...`, 'info');
      try {
        await $`git -C ${repoPath} worktree add -b ${branchName} ${absoluteWorktreePath} ${remote}/${baseBranch}`;
      } catch (error) {
        // If we get "branch already exists", force delete and retry
        if (error instanceof Error && (error.message.includes('already exists') || error.message.includes('reference already exists'))) {
          onOutput?.('Stale reference detected, force cleaning...', 'warning');
          // Try multiple cleanup methods
          await $`git -C ${repoPath} branch -D ${branchName}`.catch(() => {});
          await $`git -C ${repoPath} update-ref -d refs/heads/${branchName}`.catch(() => {});
          // Prune again
          await $`git -C ${repoPath} worktree prune`.catch(() => {});
          // Retry worktree creation
          await $`git -C ${repoPath} worktree add -b ${branchName} ${absoluteWorktreePath} ${remote}/${baseBranch}`;
        } else {
          throw error;
        }
      }
    }

    onOutput?.('Worktree created successfully!', 'success');

    // Automatically install dependencies if package.json exists
    await runPackageManagerInstall(absoluteWorktreePath, onOutput);

    // Run post-create hooks if configured
    if (config.hooks?.postCreate && config.hooks.postCreate.length > 0) {
      const templateVars: TemplateVariables = {
        branch: branchName,
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

    return {
      success: true,
      worktreePath: absoluteWorktreePath,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    onOutput?.(`Error: ${errorMessage}`, 'error');
    return {
      success: false,
      error: errorMessage,
    };
  }
}
