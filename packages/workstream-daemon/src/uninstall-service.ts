#!/usr/bin/env tsx

import { unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { $ } from 'zx';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_NAME = 'com.workstream.daemon.plist';
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, PLIST_NAME);

async function uninstallService() {
  try {
    console.log('Uninstalling Workstream Daemon...');

    // Stop the service
    try {
      await $`launchctl stop com.workstream.daemon`;
      console.log('✓ Stopped daemon');
    } catch {
      console.log('  (daemon was not running)');
    }

    // Unload the service
    try {
      await $`launchctl unload ${PLIST_PATH}`;
      console.log('✓ Unloaded LaunchAgent');
    } catch {
      console.log('  (LaunchAgent was not loaded)');
    }

    // Remove plist file
    try {
      await unlink(PLIST_PATH);
      console.log('✓ Removed plist file');
    } catch {
      console.log('  (plist file was not found)');
    }

    console.log('');
    console.log('Uninstallation complete!');
    console.log('');
    console.log('Note: Cache files in ~/.workstream-daemon/ were preserved.');
    console.log('To remove them: rm -rf ~/.workstream-daemon');
  } catch (error) {
    console.error('Failed to uninstall service:', error);
    process.exit(1);
  }
}

uninstallService();
