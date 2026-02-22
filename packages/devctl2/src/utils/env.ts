import fsExtra from 'fs-extra';
const { readFile, writeFile, pathExists, copy, ensureDir } = fsExtra;
import path from 'path';
import chalk from 'chalk';
import { $ } from 'zx';
import type { DevCtl2Config, AppConfig, TemplateContext, AllocatedPorts } from '../types.js';
import { getMainWorktreePath } from './git.js';
import { interpolate } from './template.js';

$.verbose = false;

/**
 * Copy .env files from the main worktree to the current worktree
 * Only copies files that don't already exist in the current worktree
 */
async function copyEnvFilesFromMainWorktree(workdir: string): Promise<void> {
  const mainWorktreePath = await getMainWorktreePath();

  if (!mainWorktreePath) {
    // We're in the main worktree, nothing to copy
    return;
  }

  console.log(chalk.gray(`   Copying .env files from main worktree: ${mainWorktreePath}`));

  // Find all .env files in the main worktree (excluding node_modules and .git)
  try {
    const { stdout: envFiles } = await $`find ${mainWorktreePath} -name ".env" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" 2>/dev/null || true`.quiet();
    const envFilePaths = envFiles.trim().split('\n').filter(p => p);

    for (const sourcePath of envFilePaths) {
      if (!sourcePath) continue;

      // Calculate the relative path from the main worktree
      const relativePath = path.relative(mainWorktreePath, sourcePath);
      const targetPath = path.join(workdir, relativePath);

      // Only copy if the target doesn't exist
      if (!(await pathExists(targetPath))) {
        try {
          // Ensure the target directory exists
          await ensureDir(path.dirname(targetPath));
          await copy(sourcePath, targetPath);
          console.log(chalk.gray(`   Copied ${relativePath}`));
        } catch (error) {
          console.log(chalk.yellow(`   ⚠️  Could not copy ${relativePath}: ${(error as Error).message}`));
        }
      }
    }
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not find .env files in main worktree: ${(error as Error).message}`));
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
  // First, copy any missing .env files from the main worktree
  await copyEnvFilesFromMainWorktree(workdir);

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
