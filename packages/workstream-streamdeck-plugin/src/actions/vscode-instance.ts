import {
  action,
  KeyAction,
  DialAction,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import type { VSCodeInstance } from '../types';
import { focusVSCodeWindow } from '../utils/vscode-activator';
import { generateInstanceIcon } from '../utils/icon-generator';

/**
 * Common default branch names that don't need to be shown
 */
const DEFAULT_BRANCHES = ['main', 'master', 'develop', 'development', 'dev'];

/**
 * Check if a branch name is a default/common branch
 */
function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.includes(branch.toLowerCase());
}

/**
 * Represents a registered action instance on the Stream Deck
 */
interface ActionInstance {
  context: string;
  action: KeyAction<VSCodeInstanceSettings> | DialAction<VSCodeInstanceSettings>;
  order: number; // Order in which it was registered (0, 1, 2, etc.)
}

/**
 * Global state for VSCode instances
 * This will be updated by the plugin when Redis sends updates
 */
export class InstanceStore {
  private static _instances: VSCodeInstance[] = [];
  private static _listeners: Set<(instances: VSCodeInstance[]) => void> = new Set();
  private static _actionInstances: Map<string, ActionInstance> = new Map();
  private static _nextOrder = 0;

  static setInstances(instances: VSCodeInstance[]): void {
    this._instances = instances;
    // Notify all listeners
    this._listeners.forEach((listener) => listener(instances));
  }

  static getInstances(): VSCodeInstance[] {
    return this._instances;
  }

  static subscribe(listener: (instances: VSCodeInstance[]) => void): () => void {
    this._listeners.add(listener);
    // Return unsubscribe function
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Register an action instance (a button on the Stream Deck)
   */
  static registerAction(
    context: string,
    action: KeyAction<VSCodeInstanceSettings> | DialAction<VSCodeInstanceSettings>
  ): void {
    if (!this._actionInstances.has(context)) {
      this._actionInstances.set(context, {
        context,
        action,
        order: this._nextOrder++,
      });
    }
  }

  /**
   * Unregister an action instance
   */
  static unregisterAction(context: string): void {
    this._actionInstances.delete(context);
  }

  /**
   * Get the VSCode instance for a specific action based on its registration order
   */
  static getInstanceForAction(context: string): VSCodeInstance | null {
    const actionInstance = this._actionInstances.get(context);
    if (!actionInstance) {
      return null;
    }

    // Get all registered actions sorted by order
    const sortedActions = Array.from(this._actionInstances.values()).sort(
      (a, b) => a.order - b.order
    );

    // Find the index of this action in the sorted list
    const index = sortedActions.findIndex((a) => a.context === context);

    if (index === -1 || index >= this._instances.length) {
      return null;
    }

    return this._instances[index];
  }

  /**
   * Get all registered action instances
   */
  static getActionInstances(): ActionInstance[] {
    return Array.from(this._actionInstances.values()).sort(
      (a, b) => a.order - b.order
    );
  }
}

/**
 * VSCode Instance Switcher action
 * Displays a VSCode workspace and focuses it when pressed
 *
 * Multiple instances of this action will automatically distribute across available
 * VSCode instances (1st button = instance 0, 2nd button = instance 1, etc.)
 */
@action({ UUID: 'com.adam-hancock.workstream-streamdeck-plugin.vscode-instance' })
export class VSCodeInstanceAction extends SingletonAction<VSCodeInstanceSettings> {
  private unsubscribe?: () => void;
  private currentContext?: string;

  /**
   * When the action appears, register it and set up the initial state
   */
  override async onWillAppear(
    ev: WillAppearEvent<VSCodeInstanceSettings>
  ): Promise<void> {
    this.currentContext = ev.action.id;

    // Register this action instance
    InstanceStore.registerAction(ev.action.id, ev.action);

    // Update the display immediately
    await this.updateDisplay(ev.action.id, ev.action);

    // Subscribe to instance updates
    this.unsubscribe = InstanceStore.subscribe(async () => {
      // Update all registered actions
      await this.updateAllActions();
    });
  }

  /**
   * When the action disappears, unregister it
   */
  override onWillDisappear(
    ev: WillDisappearEvent<VSCodeInstanceSettings>
  ): void | Promise<void> {
    // Unregister this action instance
    InstanceStore.unregisterAction(ev.action.id);

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.currentContext = undefined;
  }

  /**
   * When the button is pressed, focus the VSCode window
   */
  override async onKeyDown(ev: KeyDownEvent<VSCodeInstanceSettings>): Promise<void> {
    // Get the instance assigned to this action
    const instance = InstanceStore.getInstanceForAction(ev.action.id);

    if (!instance) {
      await ev.action.showAlert();
      return;
    }

    try {
      // Focus the VSCode window
      await focusVSCodeWindow(instance.path);
      await ev.action.showOk();
    } catch (error) {
      await ev.action.showAlert();
    }
  }

  /**
   * Update all registered action instances
   */
  private async updateAllActions(): Promise<void> {
    const actionInstances = InstanceStore.getActionInstances();

    for (const { context, action } of actionInstances) {
      await this.updateDisplay(context, action);
    }
  }

  /**
   * Update the display for a specific action instance
   */
  private async updateDisplay(
    context: string,
    action: KeyAction<VSCodeInstanceSettings> | DialAction<VSCodeInstanceSettings>
  ): Promise<void> {
    const instance = InstanceStore.getInstanceForAction(context);

    // Determine what text to display
    let displayText = '';

    if (instance) {
      if (instance.branch && !isDefaultBranch(instance.branch)) {
        // Show branch name if it's not a default branch (main, master, etc.)
        displayText = instance.branch;
      } else {
        // Show workspace name for default branches or when no branch
        displayText = instance.name;
      }
    } else {
      displayText = 'No Instance';
    }

    // Generate and set the icon with embedded text (dynamic font sizing)
    const iconSvg = generateInstanceIcon(instance, displayText);

    // Only KeyAction supports setImage
    if ('setImage' in action) {
      await action.setImage(iconSvg);
    }

    // Clear the title since text is now in the icon
    await action.setTitle('');
  }
}

/**
 * Settings for {@link VSCodeInstanceAction}
 */
type VSCodeInstanceSettings = {
  // No user-configurable settings currently needed
  // Title shows branch name (auto-truncated)
  // Status is shown via icon color
};
