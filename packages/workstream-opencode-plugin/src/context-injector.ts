import { getRedisClient } from './redis-client.ts';
import { REDIS_KEYS, type WorkstreamInstance } from './types.ts';

export class ContextInjector {
  /**
   * Get enhanced context for the current workspace
   */
  async getWorkspaceContext(workspacePath: string): Promise<string> {
    try {
      const redis = getRedisClient();
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);

      if (!instanceData) {
        return '';
      }

      const instance: WorkstreamInstance = JSON.parse(instanceData);
      const parts: string[] = [];

      // Add git context
      if (instance.gitInfo) {
        parts.push(`**Git Context:**`);
        parts.push(`- Branch: ${instance.gitInfo.branch}`);
        parts.push(`- Status: ${instance.gitInfo.isDirty ? 'Dirty' : 'Clean'}`);
        if (instance.gitInfo.isDirty) {
          parts.push(`- Changes: ${instance.gitInfo.modified} modified, ${instance.gitInfo.staged} staged, ${instance.gitInfo.untracked} untracked`);
        }
        parts.push('');
      }

      // Add PR context
      if (instance.prStatus) {
        parts.push(`**Pull Request #${instance.prStatus.number}:**`);
        parts.push(`- Title: ${instance.prStatus.title}`);
        parts.push(`- State: ${instance.prStatus.state}`);
        
        if (instance.prStatus.checks) {
          parts.push(`- CI Status: ${instance.prStatus.checks.conclusion}`);
          parts.push(`- Checks: ${instance.prStatus.checks.passing} passing, ${instance.prStatus.checks.failing} failing, ${instance.prStatus.checks.pending} pending`);
          
          // Highlight failing checks
          if (instance.prStatus.checks.failing > 0) {
            const failingChecks = instance.prStatus.checks.runs
              .filter(r => r.bucket === 'fail')
              .map(r => `  - ❌ ${r.name}`)
              .join('\n');
            parts.push(`\n**Failing Checks:**`);
            parts.push(failingChecks);
          }
        }
        
        if (instance.prStatus.mergeable === 'CONFLICTING') {
          parts.push(`- ⚠️ **Merge Conflicts Detected**`);
        }
        parts.push('');
      }

      // Add development environment context
      if (instance.caddyHost) {
        parts.push(`**Development Environment:**`);
        parts.push(`- URL: ${instance.caddyHost.url}`);
        parts.push('');
      }

      // Add Spotlight errors context
      if (instance.spotlightStatus && instance.spotlightStatus.errorCount > 0) {
        parts.push(`**⚠️ Spotlight Errors:**`);
        parts.push(`- ${instance.spotlightStatus.errorCount} errors detected`);
        parts.push(`- ${instance.spotlightStatus.traceCount} traces`);
        parts.push(`- Suggestion: Use getSpotlightErrors() tool for details`);
        parts.push('');
      }

      // Add other Claude sessions context
      if (instance.claudeStatus?.active) {
        const status = instance.claudeStatus.isWorking ? 'working' : 
                      instance.claudeStatus.isWaiting ? 'waiting for input' : 'active';
        parts.push(`**Other Claude Sessions:**`);
        parts.push(`- VSCode Claude is currently ${status}`);
        parts.push(`- Tip: Coordinate to avoid file conflicts`);
        parts.push('');
      }

      // Add VSCode extension context
      if (instance.extensionActive) {
        parts.push(`**VSCode:**`);
        parts.push(`- Workstream extension is active`);
        parts.push(`- Real-time file tracking enabled`);
        parts.push('');
      }

      if (parts.length === 0) {
        return '';
      }

      return `\n---\n## 📊 Workstream Context\n\n${parts.join('\n')}\n---\n`;
    } catch (error) {
      return '';
    }
  }

  /**
   * Inject context into a prompt/message
   */
  async injectContext(prompt: string, workspacePath: string): Promise<string> {
    const context = await this.getWorkspaceContext(workspacePath);
    if (!context) {
      return prompt;
    }

    // Inject context at the beginning of the prompt
    return `${context}\n${prompt}`;
  }

  /**
   * Get PR-specific suggestions
   */
  async getPRSuggestions(workspacePath: string): Promise<string[]> {
    try {
      const redis = getRedisClient();
      const key = REDIS_KEYS.INSTANCE(workspacePath);
      const instanceData = await redis.get(key);

      if (!instanceData) {
        return [];
      }

      const instance: WorkstreamInstance = JSON.parse(instanceData);
      const suggestions: string[] = [];

      if (instance.prStatus) {
        // Failing checks suggestion
        if (instance.prStatus.checks?.failing && instance.prStatus.checks.failing > 0) {
          const failingChecks = instance.prStatus.checks.runs
            .filter(r => r.bucket === 'fail')
            .map(r => r.name);
          suggestions.push(`Your PR has ${failingChecks.length} failing check(s): ${failingChecks.join(', ')}. Would you like me to investigate?`);
        }

        // Merge conflict suggestion
        if (instance.prStatus.mergeable === 'CONFLICTING') {
          suggestions.push(`Your PR has merge conflicts. I can help resolve them if you'd like.`);
        }

        // Pending checks suggestion
        if (instance.prStatus.checks?.pending && instance.prStatus.checks.pending > 0) {
          suggestions.push(`There are ${instance.prStatus.checks.pending} checks still running. Would you like me to wait for them to complete?`);
        }
      }

      // Git dirty state suggestion
      if (instance.gitInfo?.isDirty) {
        suggestions.push(`You have ${instance.gitInfo.modified + instance.gitInfo.untracked} uncommitted changes. Would you like me to help commit them?`);
      }

      // Spotlight errors suggestion
      if (instance.spotlightStatus && instance.spotlightStatus.errorCount > 0) {
        suggestions.push(`Spotlight is reporting ${instance.spotlightStatus.errorCount} errors. Should I investigate?`);
      }

      return suggestions;
    } catch (error) {
      return [];
    }
  }
}
