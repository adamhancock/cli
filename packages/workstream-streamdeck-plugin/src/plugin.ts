import streamDeck, { LogLevel } from '@elgato/streamdeck';

import { IncrementCounter } from './actions/increment-counter';
import { VSCodeInstanceAction, InstanceStore } from './actions/vscode-instance';
import { redisManager } from './utils/redis-client';
import {
  loadInstancesFromRedis,
  subscribeToUpdates,
  unsubscribeFromUpdates,
} from './utils/instance-loader';

// Enable info logging for production use
streamDeck.logger.setLevel(LogLevel.INFO);

// Register actions
streamDeck.actions.registerAction(new IncrementCounter());
streamDeck.actions.registerAction(new VSCodeInstanceAction());

/**
 * Initialize Redis connection and start loading instances
 */
async function initialize() {
  try {
    streamDeck.logger.info('Initializing workstream plugin...');

    // Connect to Redis
    await redisManager.connect();

    // Load initial instances
    const cache = await loadInstancesFromRedis();
    InstanceStore.setInstances(cache.instances);

    streamDeck.logger.info(
      `Loaded ${cache.instances.length} VSCode instance(s)`
    );

    // Subscribe to real-time updates
    await subscribeToUpdates((newCache) => {
      streamDeck.logger.info(
        `Received update: ${newCache.instances.length} instance(s)`
      );
      InstanceStore.setInstances(newCache.instances);
    });

    streamDeck.logger.info('Workstream plugin initialized successfully');
  } catch (error) {
    streamDeck.logger.error('Failed to initialize workstream plugin:', error);
    // Continue running even if Redis is unavailable
  }
}

/**
 * Cleanup on plugin shutdown
 */
async function cleanup() {
  try {
    streamDeck.logger.info('Cleaning up workstream plugin...');
    await unsubscribeFromUpdates();
    await redisManager.disconnect();
    streamDeck.logger.info('Workstream plugin cleaned up successfully');
  } catch (error) {
    streamDeck.logger.error('Error during cleanup:', error);
  }
}

// Handle process termination
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

// Connect to Stream Deck
streamDeck.connect();

// Initialize Redis and start loading instances
initialize();
