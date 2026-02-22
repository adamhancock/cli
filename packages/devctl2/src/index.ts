#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { $ } from 'zx';
import { loadConfig, validateConfig, createExampleConfig } from './config.js';
import { CaddyClient } from './utils/caddy.js';
import { generatePorts, formatPorts } from './utils/ports.js';
import { updateAllAppEnvFiles, updateMcpConfig } from './utils/env.js';
import { createDatabase, runMigrations, dumpDatabase, restoreDatabase, listDumps, findPsqlPath } from './utils/database.js';
import { getBranch, sanitizeBranch, isGitRepo } from './utils/git.js';
import { createTemplateContext, branchToSafeId, interpolate } from './utils/template.js';

$.verbose = false;

const program = new Command();

program
  .name('devctl2')
  .description('Generic development environment manager for multi-worktree projects')
  .version('1.0.0');

/**
 * Run hooks
 */
async function runHooks(hooks: string[] | undefined, workdir: string): Promise<void> {
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    console.log(chalk.gray(`   Running: ${hook}`));
    try {
      await $({ cwd: workdir })`bash -c ${hook}`;
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  Hook failed: ${hook}`));
      console.log(chalk.gray(`   ${(error as Error).message}`));
    }
  }
}

/**
 * Setup command
 */
program
  .command('setup [name]')
  .description('Setup worktree with ports, database, and Caddy routes')
  .option('-c, --config <path>', 'Path to config file')
  .option('--root-domain', 'Use root domain instead of subdomain')
  .action(async (name, options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());
      validateConfig(config);

      const workdir = process.cwd();
      const branch = await getBranch();
      const isMainBranch = branch === 'main' || branch === 'master';

      let subdomain: string;
      const usingRootDomain = options.rootDomain || false;

      // Determine subdomain
      if (name) {
        subdomain = sanitizeBranch(name);
      } else {
        subdomain = sanitizeBranch(branch);
      }

      // Run preSetup hooks
      if (config.hooks?.preSetup) {
        console.log(chalk.blue('🔧 Running pre-setup hooks...'));
        await runHooks(config.hooks.preSetup, workdir);
      }

      // Use existing ports from .env files for main branch, generate unique ports for worktrees
      let ports: Record<string, number>;
      if (isMainBranch) {
        // Read ports directly from .env files for main branch
        ports = {};
        for (const [appName, appConfig] of Object.entries(config.apps)) {
          if (appConfig.portVar && config.portRanges[appName]) {
            const envPath = path.join(workdir, appConfig.envFile);
            if (existsSync(envPath)) {
              const envContent = readFileSync(envPath, 'utf8');
              const regex = new RegExp(`^${appConfig.portVar}=(\\d+)$`, 'm');
              const match = envContent.match(regex);
              if (match) {
                ports[appName] = parseInt(match[1]);
              }
            }
            // Fallback to portRanges.start if not found in .env
            if (!ports[appName]) {
              ports[appName] = config.portRanges[appName].start;
            }
          }
        }
      } else {
        ports = await generatePorts(config, workdir);
      }

      console.log(chalk.blue('🔧 Setting up worktree...'));
      console.log(chalk.gray(`   Branch: ${branch}`));
      console.log(chalk.gray(`   Domain: ${usingRootDomain ? config.baseDomain : `${subdomain}.${config.baseDomain}`}`));

      // Display allocated ports
      for (const [appName, port] of Object.entries(ports)) {
        console.log(chalk.gray(`   ${appName} port: ${port}`));
      }

      // Create database if enabled and not main branch
      let dbName = '';
      let databaseCreated = false;
      const safeId = branchToSafeId(branch);

      if (config.features.database && !isMainBranch) {
        dbName = `${config.databasePrefix}_${safeId}`;
        const dbResult = await createDatabase(config, dbName, workdir);
        databaseCreated = dbResult.created;
      }

      // Update env files if not main branch
      if (!isMainBranch) {
        // Create template context
        const context = createTemplateContext(
          branch,
          config.baseDomain,
          config.databasePrefix,
          config.database,
          ports
        );

        await updateAllAppEnvFiles(config, workdir, context);

        // Update MCP config if database was created or spotlight is enabled
        if (databaseCreated || ports.spotlight) {
          await updateMcpConfig(workdir, context.databaseUrl, ports.spotlight || null);
        }

        // Run migrations if database was created
        if (databaseCreated && config.features.database) {
          await runMigrations(config, dbName, workdir);
        }

        console.log(chalk.green('✅ Environment files updated'));
      } else {
        console.log(chalk.yellow('⚠️  Skipping env file updates for main branch'));
      }

      // Add Caddy route if enabled
      if (config.features.caddy) {
        try {
          const caddy = new CaddyClient(config.caddyApi);
          // Pass ports in the format Caddy expects
          const caddyPorts = {
            api: ports.api || 3001,
            web: ports.web || 5173,
            spotlight: ports.spotlight || null
          };
          await caddy.addRoute(subdomain, caddyPorts, workdir, config.baseDomain, usingRootDomain);

          const frontendUrl = usingRootDomain ? `https://${config.baseDomain}` : `https://${subdomain}.${config.baseDomain}`;
          console.log(chalk.green('✅ Added Caddy route'));
          console.log(`   🌐 ${chalk.blue(frontendUrl)}`);

          // Show Spotlight URL if enabled
          if (caddyPorts.spotlight) {
            console.log(`   🔍 ${chalk.magenta(`${frontendUrl}:8888`)} (spotlight)`);
          }

          // Add standalone routes for apps with custom hostnames
          for (const [appName, appConfig] of Object.entries(config.apps)) {
            if (appConfig.hostname && ports[appName]) {
              const context = createTemplateContext(
                branch,
                config.baseDomain,
                config.databasePrefix,
                config.database,
                ports
              );
              const hostname = interpolate(appConfig.hostname, context);
              const routeId = `${subdomain}-${appName}`;

              // Pass API port so standalone routes can proxy /api/* requests
              await caddy.addStandaloneRoute(routeId, hostname, ports[appName], workdir, ports.api);
              console.log(`   🌐 ${chalk.blue(`https://${hostname}`)} (${appName})`);
            }
          }

          // Add API-only route for OAuth callbacks
          if (ports.api) {
            const apiHostname = `${subdomain}-api.${config.baseDomain}`;
            await caddy.addStandaloneRoute(`${subdomain}-api`, apiHostname, ports.api, workdir);
            console.log(`   🌐 ${chalk.blue(`https://${apiHostname}`)} (api)`);
          }
        } catch (error) {
          console.log(chalk.yellow('⚠️  Could not add Caddy route (Caddy may not be running)'));
          console.log(chalk.gray(`   ${(error as Error).message}`));
        }
      }

      // Run postSetup hooks
      if (config.hooks?.postSetup) {
        console.log(chalk.blue('🔧 Running post-setup hooks...'));
        await runHooks(config.hooks.postSetup, workdir);
      }

      console.log(chalk.green('\n✨ Worktree setup complete!'));
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * List command
 */
program
  .command('list')
  .alias('ls')
  .description('List all active Caddy routes')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());
      const caddy = new CaddyClient(config.caddyApi);

      await caddy.listRoutes(config.baseDomain);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Remove command
 */
program
  .command('remove <subdomain>')
  .alias('rm')
  .description('Remove Caddy route for subdomain')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (subdomain, options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());
      const caddy = new CaddyClient(config.caddyApi);

      await caddy.removeRoute(subdomain);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Ports command
 */
program
  .command('ports <subdomain>')
  .description('Get port information for subdomain')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (subdomain, options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());
      const caddy = new CaddyClient(config.caddyApi);

      const ports = await caddy.getPortsForSubdomain(subdomain);
      if (ports) {
        console.log(chalk.blue(`Ports for ${subdomain}.${config.baseDomain}:`));
        console.log(`  API: ${ports.api}`);
        console.log(`  Web: ${ports.web}`);
        console.log(`  Path: ${ports.path}`);
      } else {
        console.log(chalk.yellow(`No route found for ${subdomain}.${config.baseDomain}`));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Init command
 */
program
  .command('init [project-name]')
  .description('Create a .devctl2rc.json config file')
  .option('-f, --force', 'Overwrite existing config')
  .action((projectName, options) => {
    const configPath = path.join(process.cwd(), '.devctl2rc.json');

    if (!options.force && require('fs').existsSync(configPath)) {
      console.log(chalk.yellow('⚠️  Config file already exists. Use --force to overwrite.'));
      return;
    }

    const name = projectName || path.basename(process.cwd());
    const configContent = createExampleConfig(name);

    writeFileSync(configPath, configContent);
    console.log(chalk.green('✅ Created .devctl2rc.json'));
    console.log(chalk.gray(`   Edit the file to customize settings for your project`));
  });

/**
 * Database dump command
 */
program
  .command('dump [database-name]')
  .description('Dump database to SQL file')
  .option('-c, --config <path>', 'Path to config file')
  .option('-o, --output <file>', 'Output file path')
  .action(async (dbName, options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());

      if (!dbName) {
        const branch = await getBranch();
        const safeId = branchToSafeId(branch);
        dbName = `${config.databasePrefix}_${safeId}`;
      }

      await dumpDatabase(config, dbName, options.output, process.cwd());
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Database restore command
 */
program
  .command('restore <dump-file> [database-name]')
  .description('Restore database from SQL dump file')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (dumpFile, dbName, options) => {
    try {
      const { config } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());

      if (!dbName) {
        const branch = await getBranch();
        const safeId = branchToSafeId(branch);
        dbName = `${config.databasePrefix}_${safeId}`;
      }

      await restoreDatabase(config, dumpFile, dbName, process.cwd());
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * List database dumps
 */
program
  .command('list-dumps')
  .description('List available database dump files')
  .action(async () => {
    try {
      await listDumps();
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Doctor command
 */
program
  .command('doctor')
  .description('Check environment and dependencies')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    try {
      const { config, configPath } = await loadConfig(options.config ? path.dirname(options.config) : process.cwd());

      console.log(chalk.blue('🔍 Checking environment...\n'));

      // Check config
      console.log(chalk.cyan('Configuration:'));
      if (configPath) {
        console.log(chalk.green(`  ✓ Config found: ${configPath}`));
      } else {
        console.log(chalk.yellow(`  ⚠ No config file found, using defaults`));
      }

      // Check git
      console.log(chalk.cyan('\nGit:'));
      if (await isGitRepo()) {
        const branch = await getBranch();
        console.log(chalk.green(`  ✓ Git repository detected`));
        console.log(chalk.gray(`    Current branch: ${branch}`));
      } else {
        console.log(chalk.yellow(`  ⚠ Not a git repository`));
      }

      // Check Caddy
      if (config.features.caddy) {
        console.log(chalk.cyan('\nCaddy:'));
        try {
          const caddy = new CaddyClient(config.caddyApi);
          await caddy.request('GET', '/config/');
          console.log(chalk.green(`  ✓ Caddy is running (${config.caddyApi})`));
        } catch (error) {
          console.log(chalk.red(`  ✗ Caddy is not running or not accessible`));
          console.log(chalk.gray(`    ${(error as Error).message}`));
        }
      }

      // Check PostgreSQL
      if (config.features.database) {
        console.log(chalk.cyan('\nPostgreSQL:'));
        const pgTools = await findPsqlPath();
        if (pgTools) {
          console.log(chalk.green(`  ✓ PostgreSQL tools found (${pgTools.type})`));
        } else {
          console.log(chalk.red(`  ✗ PostgreSQL tools not found`));
          console.log(chalk.gray(`    Install: brew install postgresql`));
        }
      }

      // Check configured apps
      console.log(chalk.cyan('\nConfigured apps:'));
      for (const [appName, appConfig] of Object.entries(config.apps)) {
        console.log(chalk.gray(`  - ${appName}: ${appConfig.envFile}`));
      }

      console.log(chalk.green('\n✅ Environment check complete'));
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
