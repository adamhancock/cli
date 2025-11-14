/**
 * Configuration for git worktree creation and setup
 * Loaded from .worktreerc.json or .worktreerc files
 */
export interface WorktreeRcConfig {
  vscode?: VSCodeSettings;
  worktree?: WorktreeSettings;
  git?: GitSettings;
  env?: EnvSettings;
  packageManager?: PackageManagerSettings;
  hooks?: HookSettings;
}

/**
 * VS Code configuration settings
 */
export interface VSCodeSettings {
  /**
   * Custom VS Code command (default: "code")
   */
  command?: string;

  /**
   * Additional arguments to pass to VS Code
   */
  args?: string[];

  /**
   * Whether to open VS Code after worktree creation (default: true)
   */
  open?: boolean;
}

/**
 * Worktree location and naming configuration
 */
export interface WorktreeSettings {
  /**
   * Prefix for worktree directory names
   */
  prefix?: string;

  /**
   * Custom location pattern with template variables:
   * - {repo}: Repository name
   * - {prefix}: The configured prefix
   * - {branch}: Branch name with slashes replaced by hyphens
   * - {original-branch}: Original branch name unchanged
   *
   * Example: "../worktrees/{repo}-{branch}"
   */
  location?: string;
}

/**
 * Git-related configuration
 */
export interface GitSettings {
  /**
   * Whether to fetch before creating worktree (default: true)
   */
  fetch?: boolean;

  /**
   * Remote name to use (default: "origin")
   */
  remote?: string;

  /**
   * Default branch for new branches (default: "main")
   */
  defaultBranch?: string;

  /**
   * Automatically push new branches to remote (default: false)
   */
  pushNewBranches?: boolean;
}

/**
 * Environment file configuration
 */
export interface EnvSettings {
  /**
   * Whether to copy environment files (default: true)
   */
  copy?: boolean;

  /**
   * Glob patterns for environment files (default: [".env*"])
   */
  patterns?: string[];

  /**
   * Patterns to exclude from copying
   */
  exclude?: string[];
}

/**
 * Package manager configuration
 */
export interface PackageManagerSettings {
  /**
   * Whether to auto-install dependencies (default: true)
   */
  install?: boolean;

  /**
   * Force a specific package manager
   */
  force?: 'npm' | 'yarn' | 'pnpm' | 'bun';

  /**
   * Custom install command (overrides auto-detection)
   */
  command?: string;
}

/**
 * Hook configuration
 */
export interface HookSettings {
  /**
   * Commands to run after worktree creation
   * Supports template variables:
   * - {repo}: Repository name
   * - {branch}: Selected branch name
   * - {safeBranch}: Branch name with slashes replaced by hyphens
   * - {worktreePath}: Absolute path to worktree
   * - {originalDir}: Original repository directory
   * - {prefix}: Configured prefix
   * - {remote}: Git remote name
   * - {defaultBranch}: Default branch name
   */
  postCreate?: string[];
}

/**
 * Template variables available for substitution in hooks and paths
 */
export interface TemplateVariables {
  repo: string;
  branch: string;
  safeBranch: string;
  worktreePath: string;
  originalDir: string;
  prefix: string;
  remote: string;
  defaultBranch: string;
}
