#!/usr/bin/env tsx

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAEMON_NAME = 'workstream-daemon';
const WS_PORT = 58234;
const LOG_DIR = join(homedir(), 'Library', 'Logs');
const STDOUT_LOG = join(LOG_DIR, 'workstream-daemon.log');
const STDERR_LOG = join(LOG_DIR, 'workstream-daemon-error.log');

async function isRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`lsof -i :${WS_PORT} -t`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function getPid(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`lsof -i :${WS_PORT} -t`);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function start() {
  const running = await isRunning();
  if (running) {
    console.log('✅ Daemon is already running');
    return;
  }

  console.log('🚀 Starting workstream daemon...');

  const indexPath = join(__dirname, 'index.ts');
  const child = spawn('tsx', [indexPath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  // Wait a bit to verify it started
  await new Promise(resolve => setTimeout(resolve, 1000));

  const isNowRunning = await isRunning();
  if (isNowRunning) {
    console.log('✅ Daemon started successfully');
  } else {
    console.error('❌ Failed to start daemon');
    process.exit(1);
  }
}

async function stop() {
  const pid = await getPid();
  if (!pid) {
    console.log('⚠️  Daemon is not running');
    return;
  }

  console.log(`🛑 Stopping daemon (PID: ${pid})...`);

  try {
    await execAsync(`kill ${pid}`);
    console.log('✅ Daemon stopped');
  } catch (error) {
    console.error('❌ Failed to stop daemon:', error);
    process.exit(1);
  }
}

async function status() {
  const running = await isRunning();
  const pid = await getPid();

  if (running && pid) {
    console.log('✅ Daemon is running');
    console.log(`   PID: ${pid}`);
    console.log(`   Port: ${WS_PORT}`);
    console.log(`   WebSocket: ws://localhost:${WS_PORT}`);
  } else {
    console.log('❌ Daemon is not running');
  }
}

async function install() {
  const { execFileSync } = await import('child_process');
  const installScriptPath = join(__dirname, 'install-service.ts');

  console.log('📦 Installing as macOS service...');

  try {
    execFileSync('tsx', [installScriptPath], { stdio: 'inherit' });
  } catch (error) {
    console.error('❌ Failed to install service');
    process.exit(1);
  }
}

async function uninstall() {
  const { execFileSync } = await import('child_process');
  const uninstallScriptPath = join(__dirname, 'uninstall-service.ts');

  console.log('🗑️  Uninstalling service...');

  try {
    execFileSync('tsx', [uninstallScriptPath], { stdio: 'inherit' });
  } catch (error) {
    console.error('❌ Failed to uninstall service');
    process.exit(1);
  }
}

async function runInConsole() {
  const running = await isRunning();
  if (running) {
    console.log('⚠️  Daemon is already running in background');
    console.log('Stop it first with: workstream stop');
    process.exit(1);
  }

  console.log('🚀 Starting workstream daemon in console mode...');
  console.log('Press Ctrl+C to stop\n');

  const indexPath = join(__dirname, 'index.ts');
  const child = spawn('tsx', [indexPath], {
    stdio: 'inherit', // Show output in current terminal
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping daemon...');
    child.kill('SIGTERM');
    setTimeout(() => {
      process.exit(0);
    }, 100);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n❌ Daemon exited with code ${code}`);
      process.exit(code);
    }
    process.exit(0);
  });

  child.on('error', (error) => {
    console.error('❌ Failed to start daemon:', error);
    process.exit(1);
  });
}

async function logs() {
  const logsType = process.argv[3] || 'all';

  let files: string[] = [];

  switch (logsType) {
    case 'all':
      files = [STDOUT_LOG, STDERR_LOG];
      break;
    case 'stdout':
      files = [STDOUT_LOG];
      break;
    case 'stderr':
      files = [STDERR_LOG];
      break;
    default:
      console.error(`❌ Unknown log type: ${logsType}`);
      console.log('Valid types: all, stdout, stderr');
      process.exit(1);
  }

  // Check if log files exist
  const existingFiles = files.filter(f => existsSync(f));

  if (existingFiles.length === 0) {
    console.error('❌ No log files found. Make sure the daemon is installed as a service.');
    console.log('\nLog files are only created when running as a LaunchAgent.');
    console.log('Run "workstream install" to install the service.');
    process.exit(1);
  }

  console.log(`📋 Watching logs: ${existingFiles.map(f => f.split('/').pop()).join(', ')}`);
  console.log('Press Ctrl+C to exit\n');

  // Use tail -f to follow logs
  const tail = spawn('tail', ['-f', '-n', '50', ...existingFiles], {
    stdio: 'inherit',
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    tail.kill();
    console.log('\n👋 Stopped watching logs');
    process.exit(0);
  });

  tail.on('error', (error) => {
    console.error('❌ Failed to tail logs:', error);
    process.exit(1);
  });
}

function showHelp() {
  console.log(`
Workstream Daemon - VS Code instance metadata indexer

Usage:
  workstream <command> [options]

Commands:
  start       Start the daemon in the background
  stop        Stop the running daemon
  console     Run the daemon in the foreground with live output
  status      Check if daemon is running
  logs        Watch daemon logs in real-time
              Options: all (default), stdout, stderr
  install     Install as macOS LaunchAgent (auto-start on login)
  uninstall   Uninstall the LaunchAgent
  help        Show this help message

Examples:
  workstream start         # Start the daemon in background
  workstream console       # Run in foreground (useful for debugging)
  workstream status        # Check status
  workstream logs          # Watch all logs
  workstream logs stderr   # Watch only error logs
  workstream install       # Install as service
`);
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      await stop();
      break;
    case 'console':
      await runInConsole();
      break;
    case 'status':
      await status();
      break;
    case 'logs':
      await logs();
      break;
    case 'install':
      await install();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('Run "workstream help" for usage information');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
