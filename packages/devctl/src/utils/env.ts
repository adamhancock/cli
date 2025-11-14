import fsExtra from 'fs-extra';
const { readFile, writeFile, pathExists } = fsExtra;
import path from 'path';
import chalk from 'chalk';
import { $ } from 'zx';
import type { DevCtlConfig, Ports, DatabaseInfo } from '../types.js';

$.verbose = false;

/**
 * Update environment files with port configuration and database settings
 */
export async function updateEnvFiles(
  config: DevCtlConfig,
  workdir: string,
  ports: Ports,
  subdomain: string,
  databaseInfo: DatabaseInfo | null = null
): Promise<string> {
  const dbName = databaseInfo?.dbName || `${config.databasePrefix}_${subdomain.replace(/-/g, '_')}`;
  const queuePrefix = subdomain.replace(/-/g, '_');
  const baseUrl = databaseInfo?.usingRootDomain ? `https://${config.baseDomain}` : `https://${subdomain}.${config.baseDomain}`;

  // Update DATABASE_URL in all .env files if database was created
  if (config.features.database && databaseInfo?.created) {
    const newDatabaseUrl = `postgresql://${config.database.user}:${config.database.password}@${config.database.host}:${config.database.port}/${dbName}`;

    // Find all .env files (excluding .env.example files)
    const { stdout: envFiles } = await $`find ${workdir} -name ".env" -type f ! -name "*.example" 2>/dev/null || true`.quiet();
    const envFilePaths = envFiles.trim().split('\n').filter(p => p && !p.includes('.env.example'));

    for (const envPath of envFilePaths) {
      if (!envPath) continue;

      try {
        const normalizedPath = envPath;

        // Skip specific directories that should keep their own database
        if (normalizedPath.includes('mock-integration-server')) {
          console.log(chalk.gray(`   Skipping mock-integration-server (uses fixed database)`));
          continue;
        }

        if (await pathExists(normalizedPath)) {
          let envContent = await readFile(normalizedPath, 'utf8');

          // Check if this file has a DATABASE_URL
          if (envContent.includes('DATABASE_URL=')) {
            // Replace the DATABASE_URL line
            envContent = envContent.split('\n').map(line => {
              if (line.startsWith('DATABASE_URL=')) {
                return `DATABASE_URL=${newDatabaseUrl}`;
              }
              return line;
            }).join('\n');

            await writeFile(normalizedPath, envContent);
            console.log(chalk.gray(`   Updated DATABASE_URL in ${path.relative(workdir, normalizedPath)}`));
          }
        }
      } catch (error) {
        // Silently skip files we can't update
      }
    }
  }

  // Update specific env files
  await updateApiEnv(config, workdir, ports, subdomain, baseUrl, queuePrefix);
  await updateWebEnv(config, workdir, ports);

  if (config.features.spotlight && ports.spotlight) {
    await updateSpotlightEnv(config, workdir, ports);
  }

  await updateE2EEnv(config, workdir, baseUrl);

  return dbName;
}

/**
 * Update API .env file
 */
async function updateApiEnv(
  config: DevCtlConfig,
  workdir: string,
  ports: Ports,
  subdomain: string,
  baseUrl: string,
  queuePrefix: string
): Promise<void> {
  const apiEnvPath = path.join(workdir, config.envFiles.api);
  let apiEnv = '';

  if (await pathExists(apiEnvPath)) {
    apiEnv = await readFile(apiEnvPath, 'utf8');
    // Remove existing lines for variables we're updating
    const varsToUpdate = ['PORT', 'FRONTEND_URL', 'BULLMQ_QUEUE_PREFIX', 'SPOTLIGHT_PORT'];
    apiEnv = apiEnv.split('\n').filter(line =>
      !varsToUpdate.some(v => line.startsWith(`${v}=`))
    ).join('\n');
  }

  apiEnv = apiEnv.trim() + '\nPORT=' + ports.api + '\n';
  apiEnv = apiEnv.trim() + '\nFRONTEND_URL=' + baseUrl + '\n';

  if (config.features.queuePrefix) {
    apiEnv = apiEnv.trim() + '\nBULLMQ_QUEUE_PREFIX=' + queuePrefix + '\n';
  }

  if (config.features.spotlight && ports.spotlight) {
    apiEnv = apiEnv.trim() + '\nSPOTLIGHT_PORT=' + ports.spotlight + '\n';
  }

  await writeFile(apiEnvPath, apiEnv);
  console.log(chalk.gray(`   Updated ${path.relative(workdir, apiEnvPath)}`));
}

/**
 * Update Web .env file
 */
async function updateWebEnv(config: DevCtlConfig, workdir: string, ports: Ports): Promise<void> {
  const webEnvPath = path.join(workdir, config.envFiles.web);
  let webEnv = '';

  if (await pathExists(webEnvPath)) {
    webEnv = await readFile(webEnvPath, 'utf8');
    // Remove existing VITE_API_PORT and VITE_PORT lines
    webEnv = webEnv.split('\n').filter(line =>
      !line.startsWith('VITE_API_PORT=') &&
      !line.startsWith('VITE_PORT=')
    ).join('\n');
  }

  webEnv = webEnv.trim() + '\nVITE_API_PORT=' + ports.api + '\n';
  webEnv = webEnv.trim() + '\nVITE_PORT=' + ports.web + '\n';

  await writeFile(webEnvPath, webEnv);
  console.log(chalk.gray(`   Updated ${path.relative(workdir, webEnvPath)}`));
}

/**
 * Update Spotlight .env file
 */
async function updateSpotlightEnv(config: DevCtlConfig, workdir: string, ports: Ports): Promise<void> {
  if (!config.envFiles.spotlight || !ports.spotlight) return;

  const spotlightEnvPath = path.join(workdir, config.envFiles.spotlight);
  let spotlightEnv = '';

  if (await pathExists(spotlightEnvPath)) {
    spotlightEnv = await readFile(spotlightEnvPath, 'utf8');
    // Remove existing SPOTLIGHT_PORT line
    spotlightEnv = spotlightEnv.split('\n').filter(line =>
      !line.startsWith('SPOTLIGHT_PORT=')
    ).join('\n');
  }

  spotlightEnv = spotlightEnv.trim() + '\nSPOTLIGHT_PORT=' + ports.spotlight + '\n';

  await writeFile(spotlightEnvPath, spotlightEnv);
  console.log(chalk.gray(`   Updated ${path.relative(workdir, spotlightEnvPath)}`));
}

/**
 * Update E2E .env file
 */
async function updateE2EEnv(config: DevCtlConfig, workdir: string, baseUrl: string): Promise<void> {
  if (!config.envFiles.e2e) return;

  const e2eEnvPath = path.join(workdir, config.envFiles.e2e);
  let e2eEnv = '';

  console.log(chalk.gray(`   Setting E2E BASE_URL to: ${baseUrl}`));

  if (await pathExists(e2eEnvPath)) {
    e2eEnv = await readFile(e2eEnvPath, 'utf8');
    // Remove existing BASE_URL line
    e2eEnv = e2eEnv.split('\n').filter(line =>
      !line.startsWith('BASE_URL=')
    ).join('\n');
  }

  e2eEnv = e2eEnv.trim() + '\nBASE_URL=' + baseUrl + '\n';

  await writeFile(e2eEnvPath, e2eEnv);
  console.log(chalk.gray(`   Updated ${path.relative(workdir, e2eEnvPath)}`));
}

/**
 * Update .mcp.json with Spotlight port and Postgres database URL
 */
export async function updateMcpConfig(
  config: DevCtlConfig,
  workdir: string,
  spotlightPort: number,
  databaseUrl: string | null = null
): Promise<void> {
  if (!config.integrations.mcp) {
    return;
  }

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

    // Set spotlight server configuration
    if (config.integrations.spotlight && spotlightPort) {
      mcpConfig.mcpServers.spotlight = {
        type: 'http',
        url: `http://localhost:${spotlightPort}/mcp`
      };
      console.log(chalk.gray(`   Updated .mcp.json with Spotlight URL: http://localhost:${spotlightPort}/mcp`));
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

    // Write the config file
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    console.log(chalk.green('✅ .mcp.json updated successfully'));

  } catch (error: any) {
    console.log(chalk.yellow(`⚠️  Could not update .mcp.json: ${error.message}`));
  }
}
