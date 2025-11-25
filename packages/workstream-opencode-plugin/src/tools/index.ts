/**
 * Custom Workstream Tools for OpenCode
 * 
 * Note: These tools use a mock 'tool' function since @opencode-ai/plugin
 * is not available yet. Replace with actual imports when the package is available.
 */

import { getRedisClient } from '../redis-client.ts';
import { REDIS_KEYS, type WorkstreamInstance } from '../types.ts';

// Mock tool function until @opencode-ai/plugin is available
const tool = (config: any) => config;

/**
 * Get PR status for current branch
 */
export const checkPRStatus = tool({
  description: "Check GitHub PR status for the current branch in this workspace",
  args: {},
  async execute(args: any, ctx: any) {
    try {
      const workspacePath = ctx.directory;
      const redis = getRedisClient();
      
      // Get instance data from Redis
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);
      
      if (!instanceData) {
        return "No workstream instance found for this workspace. Make sure the workstream daemon is running.";
      }
      
      const instance: WorkstreamInstance = JSON.parse(instanceData);
      
      if (!instance.prStatus) {
        return `No PR found for branch: ${instance.gitInfo?.branch || 'unknown'}`;
      }
      
      const pr = instance.prStatus;
      let response = `PR #${pr.number}: ${pr.title}\n`;
      response += `State: ${pr.state}\n`;
      response += `Mergeable: ${pr.mergeable || 'UNKNOWN'}\n`;
      
      if (pr.checks) {
        response += `\nChecks (${pr.checks.conclusion}):\n`;
        response += `  ✅ Passing: ${pr.checks.passing}\n`;
        response += `  ❌ Failing: ${pr.checks.failing}\n`;
        response += `  ⏳ Pending: ${pr.checks.pending}\n`;
        
        if (pr.checks.failing > 0) {
          response += `\nFailing checks:\n`;
          pr.checks.runs
            .filter(r => r.bucket === 'fail')
            .forEach(r => {
              response += `  - ${r.name}: ${r.state}\n`;
            });
        }
      }
      
      return response;
    } catch (error) {
      return `Error checking PR status: ${error}`;
    }
  },
});

/**
 * Get Caddy host URL
 */
export const getCaddyHost = tool({
  description: "Get the Caddy host URL for this workspace's development environment",
  args: {},
  async execute(args: any, ctx: any) {
    try {
      const workspacePath = ctx.directory;
      const redis = getRedisClient();
      
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);
      
      if (!instanceData) {
        return "No workstream instance found. Is the daemon running?";
      }
      
      const instance: WorkstreamInstance = JSON.parse(instanceData);
      
      if (!instance.caddyHost) {
        return "No Caddy host configured for this workspace.";
      }
      
      return `Caddy Host: ${instance.caddyHost.url}\nHost Name: ${instance.caddyHost.name}`;
    } catch (error) {
      return `Error getting Caddy host: ${error}`;
    }
  },
});

/**
 * Get Spotlight errors
 */
export const getSpotlightErrors = tool({
  description: "Get recent Spotlight errors and metrics for this workspace",
  args: {},
  async execute(args: any, ctx: any) {
    try {
      const workspacePath = ctx.directory;
      const redis = getRedisClient();
      
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);
      
      if (!instanceData) {
        return "No workstream instance found.";
      }
      
      const instance: WorkstreamInstance = JSON.parse(instanceData);
      
      if (!instance.spotlightStatus) {
        return "Spotlight is not configured or not running for this workspace.";
      }
      
      const spotlight = instance.spotlightStatus;
      let response = `Spotlight Status (Port ${spotlight.port}):\n`;
      response += `Status: ${spotlight.isOnline ? '🟢 Online' : '🔴 Offline'}\n`;
      response += `Errors: ${spotlight.errorCount}\n`;
      response += `Traces: ${spotlight.traceCount}\n`;
      response += `Logs: ${spotlight.logCount}\n`;
      
      if (spotlight.errorCount > 0) {
        response += `\n⚠️ There are ${spotlight.errorCount} errors. Check the Spotlight dashboard for details.`;
      }
      
      return response;
    } catch (error) {
      return `Error getting Spotlight status: ${error}`;
    }
  },
});

/**
 * Get full workstream status
 */
export const getWorkstreamStatus = tool({
  description: "Get complete workstream status including git, PR, Caddy, and Spotlight info",
  args: {},
  async execute(args: any, ctx: any) {
    try {
      const workspacePath = ctx.directory;
      const redis = getRedisClient();
      
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);
      
      if (!instanceData) {
        return "No workstream instance found. Make sure the workstream daemon is running.";
      }
      
      const instance: WorkstreamInstance = JSON.parse(instanceData);
      
      let response = `Workstream Status for ${instance.name}:\n\n`;
      
      // Git info
      if (instance.gitInfo) {
        response += `📊 Git:\n`;
        response += `  Branch: ${instance.gitInfo.branch}\n`;
        response += `  Status: ${instance.gitInfo.isDirty ? '🔴 Dirty' : '🟢 Clean'}\n`;
        response += `  Modified: ${instance.gitInfo.modified} | Staged: ${instance.gitInfo.staged} | Untracked: ${instance.gitInfo.untracked}\n\n`;
      }
      
      // PR info
      if (instance.prStatus) {
        response += `🔀 Pull Request #${instance.prStatus.number}:\n`;
        response += `  Title: ${instance.prStatus.title}\n`;
        response += `  State: ${instance.prStatus.state}\n`;
        if (instance.prStatus.checks) {
          response += `  Checks: ${instance.prStatus.checks.conclusion} (${instance.prStatus.checks.passing}✅ ${instance.prStatus.checks.failing}❌ ${instance.prStatus.checks.pending}⏳)\n`;
        }
        response += `\n`;
      }
      
      // Caddy
      if (instance.caddyHost) {
        response += `🌐 Caddy:\n`;
        response += `  URL: ${instance.caddyHost.url}\n\n`;
      }
      
      // Spotlight
      if (instance.spotlightStatus) {
        response += `💡 Spotlight:\n`;
        response += `  Status: ${instance.spotlightStatus.isOnline ? 'Online' : 'Offline'}\n`;
        response += `  Errors: ${instance.spotlightStatus.errorCount}\n`;
        response += `  Traces: ${instance.spotlightStatus.traceCount}\n\n`;
      }
      
      // VSCode extension
      if (instance.extensionActive) {
        response += `📝 VSCode Extension: Active\n`;
      }
      
      // Claude status
      if (instance.claudeStatus?.active) {
        response += `🤖 Claude: ${instance.claudeStatus.isWorking ? 'Working' : instance.claudeStatus.isWaiting ? 'Waiting' : 'Active'}\n`;
      }
      
      return response;
    } catch (error) {
      return `Error getting workstream status: ${error}`;
    }
  },
});

// Export all tools
export const workstreamTools = {
  checkPRStatus,
  getCaddyHost,
  getSpotlightErrors,
  getWorkstreamStatus,
};
