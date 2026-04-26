import fsExtra from 'fs-extra';
const { readFile, writeFile, pathExists, copy, ensureDir, symlink, lstat, unlink } = fsExtra;
import path from 'path';
import chalk from 'chalk';
import { $ } from 'zx';
import type { DevCtl2Config, AppConfig, TemplateContext, AllocatedPorts } from '../types.js';
import { getMainWorktreePath } from './git.js';
import { interpolate } from './template.js';

$.verbose = false;

/**
 * Copy .env files from the main worktree to the current worktree.
 * When symlinkEnv is true, files are symlinked instead of copied.
 * Files that need worktree-specific patching (listed in apps config) are
 * always copied since they need per-worktree PORT, DATABASE_URL, etc.
 * Other .env files (shared secrets with no per-worktree vars) stay as symlinks
 * so that secret rotations in main propagate immediately to all worktrees.
 */
async function copyEnvFilesFromMainWorktree(
  workdir: string,
  config: DevCtl2Config
): Promise<void> {
  const mainWorktreePath = await getMainWorktreePath();

  if (!mainWorktreePath) {
    // We're in the main worktree, nothing to copy/symlink
    return;
  }

  const useSymlinks = config.symlinkEnv !== false;

  // Collect env files that need worktree-specific patching (always copied + patched)
  const patchedEnvFiles = new Set<string>();
  for (const appConfig of Object.values(config.apps)) {
    patchedEnvFiles.add(appConfig.envFile);
  }

  if (useSymlinks) {
    console.log(chalk.gray(`   Symlinking shared .env files from main worktree: ${mainWorktreePath}`));
  } else {
    console.log(chalk.gray(`   Copying .env files from main worktree: ${mainWorktreePath}`));
  }

  // Find all .env files in the main worktree (excluding node_modules and .git)
  try {
    const { stdout: envFiles } = await $`find ${mainWorktreePath} -name \".env\" -type f ! -path \"*/node_modules/*\" ! -path \"*/.git/*\" ! -path \"*/.env.example\" 2>/dev/null || true`.quiet();
    const envFilePaths = envFiles.trim().split('\n').filter(p => p);

    for (const sourcePath of envFilePaths) {
      if (!sourcePath) continue;

      // Calculate the relative path from the main worktree
      const relativePath = path.relative(mainWorktreePath, sourcePath);
      const targetPath = path.join(workdir, relativePath);

      // Check if this env file needs worktree-specific patching
      const needsPatching = patchedEnvFiles.has(relativePath);

      if (await pathExists(targetPath)) {
        // If symlinking and file doesn't need patching, replace existing file with symlink
        if (useSymlinks && !needsPatching && !(await isSymlink(targetPath))) {
          try {
            await unlink(targetPath);
            await createSymlink(sourcePath, targetPath);
            console.log(chalk.gray(`   Symlinked ${relativePath} (shared secrets)`));
          } catch (error) {
            console.log(chalk.yellow(`   ⚠️  Could not symlink ${relativePath}: ${(error as Error).message}`));
          }
        }
        // For files that need patching, they'll be handled by updateAppEnv
        continue;
      }

      // Ensure the target directory exists
      await ensureDir(path.dirname(targetPath));

      if (useSymlinks && !needsPatching) {
        // Symlink shared env files (secrets propagate from main automatically)
        try {
          await createSymlink(sourcePath, targetPath);
          console.log(chalk.gray(`   Symlinked ${relativePath} (shared secrets)`));
        } catch (error) {
          console.log(chalk.yellow(`   ⚠️  Could not symlink ${relativePath}: ${(error as Error).message}`));
          // Fall back to copying
          await copy(sourcePath, targetPath);
          console.log(chalk.gray(`   Copied ${relativePath} (symlink failed, fell back to copy)`));
        }
      } else {
        // Copy files that need per-worktree patching (or when symlinks are disabled)
        try {
          await copy(sourcePath, targetPath);
          console.log(chalk.gray(`   Copied ${relativePath}`));
        } catch (error) {
          console.log(chalk.yellow(`   ⚠️  Could not copy ${relativePath}: ${(error as Error).message}`));
        }
      }
    }
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Could not find .env files in main worktree: ${(error as Error).message}`));
  }
}

/**
 * Create a relative symlink from target to source.
 * Uses relative paths so symlinks work across different mount points.
 */
async function createSymlink(sourcePath: string, targetPath: string): Promise<void> {
  // Create a relative symlink so it works regardless of where the repo is mounted
  const relativeSourcePath = path.relative(path.dirname(targetPath), sourcePath);
  await symlink(relativeSourcePath, targetPath);
}

/**
 * Check if a path is a symlink
 */
async function isSymlink(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Update a single app's .env file based on config
 *
 * @param appName - Name of the app (e.g., 'api', 'web', 'admin')
 * @param appConfig - App configuration from devctl2 config
 * @param workdir - Working directory
 * @param context - Template context for variable interpolation
 */
export async function updateAppEnv(
  appName: string,
  appConfig: AppConfig,
  workdir: string,
  context: TemplateContext
): Promise<void> {
  const envPath = path.join(workdir, appConfig.envFile);
  const varsToUpdate: string[] = [];
  const updates: Record<string, string> = {};

  // Add port variable if specified
  if (appConfig.portVar && context.ports[appName] !== undefined) {
    varsToUpdate.push(appConfig.portVar);
    updates[appConfig.portVar] = String(context.ports[appName]);
  }

  // Add extra variables with template interpolation
  if (appConfig.extraVars) {
    for (const [varName, template] of Object.entries(appConfig.extraVars)) {
      varsToUpdate.push(varName);
      updates[varName] = interpolate(template, context);
    }
  }

  if (varsToUpdate.length === 0) {
    return;
  }

  // If the env file is a symlink, we need to replace it with a real copy
  // before patching (we can't modify a symlink's target content per-worktree)
  if (await isSymlink(envPath)) {
    // Read the symlink target content
    const { stdout: realPath } = await $`readlink -f ${envPath}`.quiet();
    const realContent = await readFile(realPath.trim(), 'utf8');

    // Remove the symlink and write a real copy
    await unlink(envPath);
    await writeFile(envPath, realContent);
    console.log(chalk.gray(`   Replaced symlink with copy for patching: ${path.relative(workdir, envPath)}`));
  }

  // Read existing file or start empty
  let envContent = '';
  if (await pathExists(envPath)) {
    envContent = await readFile(envPath, 'utf8');
    // Remove existing lines for variables we're updating
    envContent = envContent
      .split('\n')
      .filter(line => !varsToUpdate.some(v => line.startsWith(`${v}=`)))
      .join('\n');
  } else {
    // Ensure directory exists
    await ensureDir(path.dirname(envPath));
  }

  // Append updated variables
  for (const [varName, value] of Object.entries(updates)) {
    envContent = envContent.trim() + `\n${varName}=${value}\n`;
  }

  await writeFile(envPath, envContent);
  console.log(chalk.gray(`   Updated ${path.relative(workdir, envPath)}`));
}

/**
 * Update all app .env files based on config
 *
 * @param config - DevCtl2 configuration
 * @param workdir - Working directory
 * @param context - Template context for variable interpolation
 */
export async function updateAllAppEnvFiles(
  config: DevCtl2Config,
  workdir: string,
  context: TemplateContext
): Promise<void> {
  // First, copy or symlink .env files from the main worktree
  await copyEnvFilesFromMainWorktree(workdir, config);

  // Update DATABASE_URL in all .env files that have it (feature flag check)
  if (config.features.database) {
    await updateDatabaseUrlInAllEnvFiles(workdir, context.databaseUrl);
  }

  // Update each app's specific env file
  for (const [appName, appConfig] of Object.entries(config.apps)) {
    await updateAppEnv(appName, appConfig, workdir, context);
  }
}

/**
 * Update DATABASE_URL in all .env files
 */
async function updateDatabaseUrlInAllEnvFiles(
  workdir: string,
  databaseUrl: string
): Promise<void> {
  // Find all .env files (excluding .env.example files)
  const { stdout: envFiles } = await $`find ${workdir} -name ".env" -type f ! -name "*.example" ! -path "*/node_modules/*" 2>/dev/null || true`.quiet();
  const envFilePaths = envFiles.trim().split('\n').filter(p => p && !p.includes('.env.example'));

  for (const envPath of envFilePaths) {
    if (!envPath) continue;

    try {
      // Skip specific directories that should keep their own database
      if (envPath.includes('mock-integration-server')) {
        console.log(chalk.gray(`   Skipping mock-integration-server (uses fixed database)`));
        continue;
      }

      // Skip symlinks — shared env files should not have per-worktree DATABASE_URL patched in
      if (await isSymlink(envPath)) {
        console.log(chalk.gray(`   Skipping symlinked ${path.relative(workdir, envPath)} (shared secrets)`));
        continue;
      }

      if (await pathExists(envPath)) {
        let envContent = await readFile(envPath, 'utf8');

        // Check if this file has a DATABASE_URL
        if (envContent.includes('DATABASE_URL=')) {
          // Replace the DATABASE_URL line
          envContent = envContent
            .split('\n')
            .map(line => {
              if (line.startsWith('DATABASE_URL=')) {
                return `DATABASE_URL=${databaseUrl}`;
              }
              return line;
            })
            .join('\n');

          await writeFile(envPath, envContent);
          console.log(chalk.gray(`   Updated DATABASE_URL in ${path.relative(workdir, envPath)}`));
        }
      }
    } catch (error) {
      // Silently skip files we can't update
    }
  }
}

/**
 * Update .mcp.json with database URL
 */
export async function updateMcpConfig(
  workdir: string,
  databaseUrl: string,
  spotlightPort?: number | null
): Promise<void> {
  const mcpConfigPath = path.join(workdir, '.mcp.json');

  try {
    let mcpConfig: any = {};

    // Read existing config if it exists
    if (await pathExists(mcpConfigPath)) {
      mcpConfig = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
    } else {
      console.log(chalk.gray('   Creating new .mcp.json file...'));
    }

    // Initialize mcpServers if it doesn't exist
    if (!mcpConfig.mcpServers) {
      mcpConfig.mcpServers = {};
    }

    // Set postgres server configuration if database URL is provided
    if (databaseUrl) {
      mcpConfig.mcpServers.postgres = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', databaseUrl]
      };

      // Mask password in log output
      const maskedUrl = databaseUrl.replace(/:[^:@]+@/, ':****@');
      console.log(chalk.gray(`   Updated .mcp.json with Postgres database: ${maskedUrl}`));
    }

    // Set spotlight server configuration if port is provided
    if (spotlightPort) {
      mcpConfig.mcpServers.spotlight = {
        type: 'http',
        url: `http://localhost:${spotlightPort}/mcp`
      };
      console.log(chalk.gray(`   Updated .mcp.json with Spotlight MCP server on port ${spotlightPort}`));
    }

    // Write the config file
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    console.log(chalk.green('✅ .mcp.json updated successfully'));
  } catch (error: any) {
    console.log(chalk.yellow(`⚠️  Could not update .mcp.json: ${error.message}`));
  }
}