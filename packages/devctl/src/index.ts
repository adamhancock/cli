#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import path from 'path';
import { loadConfig, validateConfig, createExampleConfig } from './config.js';
import { CaddyClient } from './utils/caddy.js';
import { generatePorts } from './utils/ports.js';
import { updateEnvFiles, updateMcpConfig, updateOpencodeConfig } from './utils/env.js';
import { createDatabase, runMigrations, dumpDatabase, restoreDatabase, listDumps, findPsqlPath } from './utils/database.js';
import { getBranch, sanitizeBranch, isGitRepo } from './utils/git.js';

const program = new Command();

program
  .name('devctl')
  .description('Development environment manager for multi-worktree projects')
  .version('1.0.0');

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

      const ports = await generatePorts(config, workdir);

      console.log(chalk.blue('🔧 Setting up worktree...'));
      console.log(chalk.gray(`   Branch: ${branch}`));
      console.log(chalk.gray(`   Domain: ${usingRootDomain ? config.baseDomain : `${subdomain}.${config.baseDomain}`}`));
      console.log(chalk.gray(`   API Port: ${ports.api}`));
      console.log(chalk.gray(`   Web Port: ${ports.web}`));
      if (config.features.spotlight && ports.spotlight) {
        console.log(chalk.gray(`   Spotlight Port: ${ports.spotlight}`));
      }

      // Create database if enabled and not main branch
      let databaseInfo = { created: false, dbName: '', usingRootDomain };
      if (config.features.database && !isMainBranch) {
        const dbName = `${config.databasePrefix}_${subdomain.replace(/-/g, '_')}`;
        const dbResult = await createDatabase(config, dbName, workdir);
        databaseInfo = { ...dbResult, usingRootDomain };
      }

      // Update env files if not main branch
      if (!isMainBranch) {
        await updateEnvFiles(config, workdir, ports, subdomain, databaseInfo);

        // Update MCP config if enabled (for both Claude Code and OpenCode)
        if (config.integrations.mcp && config.features.spotlight && ports.spotlight) {
          const databaseUrl = databaseInfo.created
            ? `postgresql://${config.database.user}:${config.database.password}@${config.database.host}:${config.database.port}/${databaseInfo.dbName}`
            : null;
          await updateMcpConfig(config, workdir, ports.spotlight, databaseUrl);
          await updateOpencodeConfig(config, workdir, ports.spotlight, databaseUrl);
        }

        // Run migrations if database was created
        if (databaseInfo.created && config.features.database) {
          await runMigrations(config, databaseInfo.dbName, workdir);
        }

        console.log(chalk.green('✅ Environment files updated'));
      } else {
        console.log(chalk.yellow('⚠️  Skipping env file updates for main branch'));
      }

      // Add Caddy route
      try {
        const caddy = new CaddyClient(config.caddyApi);
        await caddy.addRoute(subdomain, ports, workdir, config.baseDomain, usingRootDomain);

        const frontendUrl = usingRootDomain ? `https://${config.baseDomain}` : `https://${subdomain}.${config.baseDomain}`;
        console.log(chalk.green('✅ Added Caddy route'));
        console.log(`   🌐 ${chalk.blue(frontendUrl)}`);
        if (config.features.spotlight && ports.spotlight) {
          console.log(`   🔍 Spotlight UI: ${chalk.cyan(`${frontendUrl}:8888`)}`);
        }
      } catch (error) {
        console.log(chalk.yellow('⚠️  Could not add Caddy route (Caddy may not be running)'));
        console.log(chalk.gray(`   ${(error as Error).message}`));
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
  .description('Create a .devctlrc.json config file')
  .option('-f, --force', 'Overwrite existing config')
  .action((projectName, options) => {
    const configPath = path.join(process.cwd(), '.devctlrc.json');

    if (!options.force && require('fs').existsSync(configPath)) {
      console.log(chalk.yellow('⚠️  Config file already exists. Use --force to overwrite.'));
      return;
    }

    const name = projectName || path.basename(process.cwd());
    const configContent = createExampleConfig(name);

    writeFileSync(configPath, configContent);
    console.log(chalk.green('✅ Created .devctlrc.json'));
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
        const subdomain = sanitizeBranch(branch);
        dbName = `${config.databasePrefix}_${subdomain.replace(/-/g, '_')}`;
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
        const subdomain = sanitizeBranch(branch);
        dbName = `${config.databasePrefix}_${subdomain.replace(/-/g, '_')}`;
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
      console.log(chalk.cyan('\nCaddy:'));
      try {
        const caddy = new CaddyClient(config.caddyApi);
        await caddy.request('GET', '/config/');
        console.log(chalk.green(`  ✓ Caddy is running (${config.caddyApi})`));
      } catch (error) {
        console.log(chalk.red(`  ✗ Caddy is not running or not accessible`));
        console.log(chalk.gray(`    ${(error as Error).message}`));
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

      console.log(chalk.green('\n✅ Environment check complete'));
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
