import { getSubscriber } from './redis-client.ts';
import { REDIS_CHANNELS, type ControlCommand } from './types.ts';

export class CommandListener {
  private isListening = false;
  private handlers: Map<string, (command: ControlCommand) => Promise<void>> = new Map();

  /**
   * Start listening for control commands from workstream daemon
   */
  async start(workspacePath: string): Promise<void> {
    if (this.isListening) {
      return;
    }

    try {
      const subscriber = getSubscriber();
      
      // Subscribe to control channel
      await subscriber.subscribe(REDIS_CHANNELS.OPENCODE_CONTROL);
      
      // Subscribe to workspace-specific channel
      const workspaceChannel = `${REDIS_CHANNELS.OPENCODE_CONTROL}:${Buffer.from(workspacePath).toString('base64')}`;
      await subscriber.subscribe(workspaceChannel);

      subscriber.on('message', async (channel, message) => {
        if (channel === REDIS_CHANNELS.OPENCODE_CONTROL || channel === workspaceChannel) {
          await this.handleCommand(message);
        }
      });

      this.isListening = true;
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Register a handler for a specific command type
   */
  onCommand(type: string, handler: (command: ControlCommand) => Promise<void>): void {
    this.handlers.set(type, handler);
  }

  /**
   * Handle incoming command
   */
  private async handleCommand(message: string): Promise<void> {
    try {
      const command = JSON.parse(message) as ControlCommand;

      const handler = this.handlers.get(command.type);
      if (handler) {
        await handler(command);
      }
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Stop listening
   */
  async stop(): Promise<void> {
    if (!this.isListening) return;

    try {
      const subscriber = getSubscriber();
      await subscriber.unsubscribe(REDIS_CHANNELS.OPENCODE_CONTROL);
      this.isListening = false;
    } catch (error) {
      // Silent fail
    }
  }
}
