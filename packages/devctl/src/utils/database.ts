import { $ } from 'zx';
import chalk from 'chalk';
import os from 'os';
import path from 'path';
import { unlink } from 'fs/promises';
import fsExtra from 'fs-extra';
const { ensureDir, readdir, stat, pathExists, readFile, writeFile } = fsExtra;
import type { DevCtlConfig, PostgresTools, DatabaseInfo } from '../types.js';

$.verbose = false;

/**
 * Parse DATABASE_URL from environment
 */
interface DatabaseCredentials {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

/**
 * Get DATABASE_URL from .env files in the workspace
 */
async function getDatabaseUrlFromEnv(config: DevCtlConfig, workdir: string): Promise<string | null> {
  // Try to find DATABASE_URL in any .env file
  const envFilePaths = [
    path.join(workdir, config.envFiles.api),
    path.join(workdir, '.env'),
  ];

  for (const envPath of envFilePaths) {
    if (await pathExists(envPath)) {
      try {
        const envContent = await readFile(envPath, 'utf8');
        const match = envContent.match(/^DATABASE_URL=(.+)$/m);
        if (match && match[1]) {
          const url = match[1].trim();
          const maskedUrl = url.replace(/:[^:@]+@/, ':****@');
          console.log(chalk.gray(`   Using DATABASE_URL from ${path.basename(envPath)}: ${maskedUrl}`));
          return url;
        }
      } catch (error) {
        // Continue to next file
      }
    }
  }

  console.log(chalk.gray(`   No DATABASE_URL found in .env files, using config credentials`));
  return null;
}

/**
 * Parse PostgreSQL connection URL
 */
function parseDatabaseUrl(url: string): DatabaseCredentials {
  const match = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)$/);
  if (!match) {
    throw new Error('Invalid DATABASE_URL format. Expected: postgresql://user:password@host:port/database');
  }

  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: parseInt(match[4]),
    database: match[5]
  };
}

/**
 * Get database credentials from .env file or config
 */
async function getDatabaseCredentials(config: DevCtlConfig, workdir: string): Promise<DatabaseCredentials> {
  // First try to get from .env file
  const databaseUrl = await getDatabaseUrlFromEnv(config, workdir);

  if (databaseUrl) {
    try {
      return parseDatabaseUrl(databaseUrl);
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not parse DATABASE_URL: ${(error as Error).message}`));
    }
  }

  // Fallback to config
  return {
    user: config.database.user,
    password: config.database.password,
    host: config.database.host,
    port: config.database.port,
    database: config.database.templateDb || `${config.databasePrefix}_dev`
  };
}

/**
 * Find PostgreSQL tools (psql, createdb, pg_dump, pg_restore)
 */
export async function findPsqlPath(): Promise<PostgresTools | null> {
  const paths = [
    'psql', // System PATH
    '/opt/homebrew/opt/libpq/bin/psql', // Homebrew ARM (libpq)
    '/opt/homebrew/bin/psql', // Homebrew ARM
    '/usr/local/bin/psql', // Homebrew Intel
    '/usr/bin/psql', // System
    '/Applications/Postgres.app/Contents/Versions/latest/bin/psql' // Postgres.app
  ];

  // Try native PostgreSQL tools first
  for (const psqlPath of paths) {
    try {
      await $`which ${psqlPath}`.quiet();
      return {
        psql: psqlPath,
        createdb: psqlPath.replace('psql', 'createdb'),
        dropdb: psqlPath.replace('psql', 'dropdb'),
        pg_dump: psqlPath.replace('psql', 'pg_dump'),
        pg_restore: psqlPath.replace('psql', 'pg_restore'),
        type: 'native'
      };
    } catch {
      // Try direct execution
      try {
        await $`${psqlPath} --version`.quiet();
        return {
          psql: psqlPath,
          createdb: psqlPath.replace('psql', 'createdb'),
          dropdb: psqlPath.replace('psql', 'dropdb'),
          pg_dump: psqlPath.replace('psql', 'pg_dump'),
          pg_restore: psqlPath.replace('psql', 'pg_restore'),
          type: 'native'
        };
      } catch {
        continue;
      }
    }
  }

  // Check if we have Docker and a PostgreSQL container
  try {
    await $`which docker`.quiet();
    const containers = await $`docker ps --format "{{.Names}}" --filter "ancestor=pgvector/pgvector:pg16"`.quiet();

    if (containers.stdout.trim()) {
      const containerName = containers.stdout.trim().split('\n')[0];
      console.log(chalk.gray(`   Found PostgreSQL Docker container: ${containerName}`));

      return {
        psql: ['docker', 'exec', containerName, 'psql'],
        createdb: ['docker', 'exec', containerName, 'createdb'],
        dropdb: ['docker', 'exec', containerName, 'dropdb'],
        pg_dump: ['docker', 'exec', containerName, 'pg_dump'],
        pg_restore: ['docker', 'exec', containerName, 'pg_restore'],
        type: 'docker',
        container: containerName
      };
    }
  } catch {
    // Docker not available or no containers
  }

  return null;
}

/**
 * Create database for worktree
 */
export async function createDatabase(config: DevCtlConfig, dbName: string, workdir: string | null = null): Promise<DatabaseInfo> {
  console.log(chalk.blue(`🗄️  Setting up database: ${dbName}`));

  // Get database credentials from .env or config
  const creds = await getDatabaseCredentials(config, workdir || process.cwd());
  const templateDb = config.database.templateDb || `${config.databasePrefix}_dev`;

  // Find PostgreSQL tools
  const pgTools = await findPsqlPath();
  if (!pgTools) {
    console.log(chalk.yellow(`⚠️  PostgreSQL tools not found. Please install PostgreSQL:`));
    console.log(chalk.gray(`   macOS: brew install postgresql`));
    console.log(chalk.gray(`   Or download Postgres.app from https://postgresapp.com`));
    console.log(chalk.gray(`   Manual setup: createdb -U ${creds.user} -h ${creds.host} -T ${templateDb} ${dbName}`));
    return { created: false, dbName };
  }

  try {
    // Check if database already exists
    let checkResult;
    console.log(chalk.gray(`   Checking if database ${dbName} already exists...`));

    if (Array.isArray(pgTools.psql)) {
      checkResult = await $`${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    } else {
      checkResult = await $`PGPASSWORD=${creds.password} ${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    }

    if (checkResult.stdout.trim() === '1') {
      console.log(chalk.yellow(`⚠️  Database ${dbName} already exists, using existing database`));
      return { created: true, dbName };
    }

    // Create database by copying the template
    console.log(chalk.gray(`   Creating database from ${templateDb} template...`));
    if (Array.isArray(pgTools.createdb)) {
      await $`${pgTools.createdb} -U ${creds.user} -h ${creds.host} -T ${templateDb} ${dbName}`.quiet();
    } else {
      await $`PGPASSWORD=${creds.password} ${pgTools.createdb} -U ${creds.user} -h ${creds.host} -T ${templateDb} ${dbName}`.quiet();
    }

    console.log(chalk.green(`✅ Database ${dbName} created successfully`));
    return { created: true, dbName };

  } catch (error: unknown) {
    const err = error as any;
    const errorMessage = err?.message || err?.stderr || String(error);
    const errorStdout = err?.stdout || '';

    if (errorStdout.includes('already exists') || errorMessage.includes('already exists')) {
      console.log(chalk.yellow(`⚠️  Database ${dbName} already exists`));
      return { created: true, dbName };
    }

    console.log(chalk.yellow(`⚠️  Could not create database ${dbName}:`));
    console.log(chalk.gray(`   ${errorMessage}`));
    return { created: false, dbName };
  }
}

/**
 * Run database migrations
 */
export async function runMigrations(config: DevCtlConfig, dbName: string, workdir: string | null = null): Promise<boolean> {
  console.log(chalk.blue(`🔄 Running database migrations for ${dbName}...`));

  try {
    let migrationResult;

    if (workdir) {
      const currentDir = process.cwd();
      process.chdir(workdir);

      try {
        migrationResult = await $`pnpm --filter @${config.projectName}/database db:migrate:deploy`.quiet();
      } finally {
        process.chdir(currentDir);
      }
    } else {
      migrationResult = await $`pnpm --filter @${config.projectName}/database db:migrate:deploy`.quiet();
    }

    if (migrationResult.exitCode === 0) {
      console.log(chalk.green('✅ Migrations applied successfully'));
      return true;
    } else {
      console.log(chalk.yellow('⚠️  Migrations may have already been applied or no pending migrations'));
      return true;
    }

  } catch (error: any) {
    if (error.stderr?.includes('No pending migrations') ||
        error.stderr?.includes('already exists') ||
        error.message?.includes('No pending migrations') ||
        error.stderr?.includes('No migrations to apply')) {
      console.log(chalk.gray('   No pending migrations to apply'));
      return true;
    }

    console.log(chalk.yellow(`⚠️  Could not run migrations: ${error.message}`));
    console.log(chalk.gray(`   You can manually run: pnpm --filter @${config.projectName}/database db:migrate:deploy`));
    return false;
  }
}

/**
 * Dump database to file
 */
export async function dumpDatabase(config: DevCtlConfig, dbName: string, outputFile: string | null = null, workdir: string | null = null): Promise<string | false> {
  // Get database credentials from .env or config
  const creds = await getDatabaseCredentials(config, workdir || process.cwd());

  const pgTools = await findPsqlPath();
  if (!pgTools) {
    console.log(chalk.red('❌ PostgreSQL tools not found. Cannot dump database.'));
    return false;
  }

  if (!outputFile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    outputFile = pgTools.type === 'docker'
      ? `/tmp/${dbName}-${timestamp}.sql`
      : `database-dumps/${dbName}-${timestamp}.sql`;
  }

  console.log(chalk.blue(`💾 Dumping database: ${dbName}`));
  console.log(chalk.gray(`   Output: ${outputFile}`));

  try {
    if (pgTools.type !== 'docker') {
      await ensureDir('database-dumps');
    }

    // Check if database exists
    let dbExists;
    if (Array.isArray(pgTools.psql)) {
      dbExists = await $`${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    } else {
      dbExists = await $`PGPASSWORD=${creds.password} ${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    }

    if (dbExists.stdout.trim() !== '1') {
      console.log(chalk.red(`❌ Database ${dbName} does not exist`));
      return false;
    }

    // Dump the database
    console.log(chalk.gray('   Creating database dump...'));
    if (Array.isArray(pgTools.pg_dump)) {
      await $`${pgTools.pg_dump} -U ${creds.user} -h ${creds.host} -d ${dbName} -f ${outputFile} --clean --if-exists --no-owner --no-acl`;
    } else {
      await $`PGPASSWORD=${creds.password} ${pgTools.pg_dump} -U ${creds.user} -h ${creds.host} -d ${dbName} -f ${outputFile} --clean --if-exists --no-owner --no-acl`;
    }

    // If using Docker, copy the file from container to host
    let finalOutputFile = outputFile;
    if (pgTools.type === 'docker' && pgTools.container) {
      await ensureDir('database-dumps');
      const fileName = path.basename(outputFile);
      finalOutputFile = `database-dumps/${fileName}`;
      await $`docker cp ${pgTools.container}:${outputFile} ${finalOutputFile}`;
      await $`docker exec ${pgTools.container} rm -f ${outputFile}`.quiet();
    }

    // Get file size
    const stats = await stat(finalOutputFile);
    const size = (stats.size / 1024 / 1024).toFixed(2);

    console.log(chalk.green(`✅ Database dumped successfully (${size} MB)`));
    console.log(chalk.gray(`   File: ${finalOutputFile}`));

    return finalOutputFile;

  } catch (error: any) {
    console.log(chalk.red('❌ Failed to dump database:'));
    console.log(chalk.gray(`   ${error.message}`));
    return false;
  }
}

/**
 * Restore database from file
 */
export async function restoreDatabase(config: DevCtlConfig, inputFile: string, dbName: string, workdir: string | null = null): Promise<boolean> {
  // Get database credentials from .env or config
  const creds = await getDatabaseCredentials(config, workdir || process.cwd());

  // Check if input file exists
  if (!await pathExists(inputFile)) {
    const fullPath = `database-dumps/${inputFile}`;
    if (!await pathExists(fullPath)) {
      console.log(chalk.red(`❌ Dump file not found: ${inputFile}`));
      return false;
    }
    inputFile = fullPath;
  }

  console.log(chalk.blue(`📥 Restoring database: ${dbName}`));
  console.log(chalk.gray(`   Source: ${inputFile}`));

  const pgTools = await findPsqlPath();
  if (!pgTools) {
    console.log(chalk.red('❌ PostgreSQL tools not found. Cannot restore database.'));
    return false;
  }

  try {
    // Check if database exists, create if it doesn't
    let dbExists;
    if (Array.isArray(pgTools.psql)) {
      dbExists = await $`${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    } else {
      dbExists = await $`PGPASSWORD=${creds.password} ${pgTools.psql} -U ${creds.user} -h ${creds.host} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.quiet();
    }

    if (dbExists.stdout.trim() !== '1') {
      console.log(chalk.gray('   Creating database...'));
      if (Array.isArray(pgTools.createdb)) {
        await $`${pgTools.createdb} -U ${creds.user} -h ${creds.host} ${dbName}`.quiet();
      } else {
        await $`PGPASSWORD=${creds.password} ${pgTools.createdb} -U ${creds.user} -h ${creds.host} ${dbName}`.quiet();
      }
    }

    // Restore the database
    console.log(chalk.gray('   Restoring database from dump...'));

    let restoreFile = inputFile;
    if (pgTools.type === 'docker' && pgTools.container) {
      const fileName = path.basename(inputFile);
      restoreFile = `/tmp/${fileName}`;
      await $`docker cp ${inputFile} ${pgTools.container}:${restoreFile}`;
    }

    if (Array.isArray(pgTools.psql)) {
      await $`${pgTools.psql} -U ${creds.user} -h ${creds.host} -d ${dbName} -f ${restoreFile}`;
    } else {
      await $`PGPASSWORD=${creds.password} ${pgTools.psql} -U ${creds.user} -h ${creds.host} -d ${dbName} -f ${restoreFile}`;
    }

    if (pgTools.type === 'docker' && pgTools.container) {
      await $`docker exec ${pgTools.container} rm -f ${restoreFile}`.quiet();
    }

    console.log(chalk.green(`✅ Database restored successfully`));
    return true;

  } catch (error: any) {
    console.log(chalk.red('❌ Failed to restore database:'));
    console.log(chalk.gray(`   ${error.message}`));
    return false;
  }
}

/**
 * List available database dumps
 */
export async function listDumps(): Promise<void> {
  console.log(chalk.blue('📦 Available database dumps:\n'));

  try {
    await ensureDir('database-dumps');
    const files = await readdir('database-dumps');
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort().reverse();

    if (sqlFiles.length === 0) {
      console.log(chalk.gray('No database dumps found'));
      console.log(chalk.gray('\nCreate a dump with: devctl dump [database-name]'));
      return;
    }

    console.log(chalk.gray('─'.repeat(80)));
    console.log(chalk.gray('Filename'.padEnd(50) + 'Size'.padEnd(10) + 'Modified'));
    console.log(chalk.gray('─'.repeat(80)));

    for (const file of sqlFiles) {
      const filePath = `database-dumps/${file}`;
      const stats = await stat(filePath);
      const size = (stats.size / 1024 / 1024).toFixed(2) + ' MB';
      const modified = stats.mtime.toLocaleString();

      console.log(
        chalk.cyan(file.padEnd(50)) +
        chalk.yellow(size.padEnd(10)) +
        chalk.gray(modified)
      );
    }

    console.log(chalk.gray('─'.repeat(80)));
    console.log(chalk.gray('\nRestore a dump with: devctl restore <filename> [database-name]'));

  } catch (error: any) {
    console.log(chalk.red('❌ Failed to list dumps:'));
    console.log(chalk.gray(`   ${error.message}`));
  }
}
