#!/usr/bin/env tsx

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { $ } from 'zx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_NAME = 'com.workstream.daemon.plist';
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, PLIST_NAME);

// Get the path to tsx and the source file
const TSX_PATH = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const DAEMON_PATH = join(__dirname, 'index.ts');

const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.workstream.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${TSX_PATH}</string>
        <string>${DAEMON_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${homedir()}/Library/Logs/workstream-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${homedir()}/Library/Logs/workstream-daemon-error.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;

async function installService() {
  try {
    console.log('Installing Workstream Daemon as LaunchAgent...');

    // Ensure LaunchAgents directory exists
    await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

    // Write plist file
    await writeFile(PLIST_PATH, plistContent);
    console.log(`✓ Created plist file: ${PLIST_PATH}`);

    // Unload if already loaded
    try {
      await $`launchctl unload ${PLIST_PATH}`;
    } catch {
      // Ignore if not loaded
    }

    // Load the service
    await $`launchctl load ${PLIST_PATH}`;
    console.log('✓ Loaded LaunchAgent');

    // Start the service
    await $`launchctl start com.workstream.daemon`;
    console.log('✓ Started daemon');

    console.log('');
    console.log('Installation complete!');
    console.log('');
    console.log('The daemon will now run automatically on login.');
    console.log(`Logs: ~/Library/Logs/workstream-daemon.log`);
    console.log(`Cache: ~/.workstream-daemon/instances.json`);
    console.log(`WebSocket: ws://localhost:58234`);
    console.log('');
    console.log('To uninstall: npm run uninstall-service');
  } catch (error) {
    console.error('Failed to install service:', error);
    process.exit(1);
  }
}

installService();
