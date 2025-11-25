/**
 * Workstream OpenCode Plugin
 * 
 * To use this plugin, symlink it to your OpenCode plugin directory:
 * 
 * Global:
 *   ln -s /path/to/workstream-opencode-plugin/.opencode/plugin/workstream.ts ~/.config/opencode/plugin/
 * 
 * Project-specific:
 *   ln -s /path/to/workstream-opencode-plugin/.opencode/plugin/workstream.ts /path/to/project/.opencode/plugin/
 */

// Import directly from TypeScript source - Bun handles this natively
import { WorkstreamPlugin } from '../../src/index.ts';

export default WorkstreamPlugin;
