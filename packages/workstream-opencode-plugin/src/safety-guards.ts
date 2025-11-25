import { publishEvent, publishNotification } from './event-publisher.ts';
import { getRedisClient } from './redis-client.ts';
import { REDIS_KEYS, type SafetyRule, type SafetyContext, type SafetyResult, type WorkstreamPluginConfig } from './types.ts';

export class SafetyGuards {
  private rules: SafetyRule[] = [];
  private config: WorkstreamPluginConfig;

  constructor(config: WorkstreamPluginConfig) {
    this.config = config;
    this.initializeRules();
  }

  private initializeRules(): void {
    // Rule 1: Protected branch check
    this.rules.push({
      id: 'protected-branch',
      description: 'Prevent operations on protected branches',
      severity: 'warning',
      check: async (context: SafetyContext): Promise<SafetyResult> => {
        if (!context.git) return { passed: true };

        const isProtected = this.config.safety.protectedBranches.includes(context.git.branch);
        if (isProtected && ['write', 'edit', 'bash'].includes(context.tool)) {
          return {
            passed: false,
            message: `You are on protected branch "${context.git.branch}"`,
            suggestion: `Consider switching to a feature branch first: git checkout -b feature/my-feature`,
          };
        }
        return { passed: true };
      },
    });

    // Rule 2: Uncommitted changes warning
    this.rules.push({
      id: 'uncommitted-changes',
      description: 'Warn about uncommitted changes',
      severity: 'warning',
      check: async (context: SafetyContext): Promise<SafetyResult> => {
        if (!context.git) return { passed: true };

        if (this.config.safety.requireCleanBranch && context.git.isDirty) {
          return {
            passed: false,
            message: `You have uncommitted changes in the workspace`,
            suggestion: `Consider committing your changes first to avoid conflicts`,
          };
        }
        return { passed: true };
      },
    });

    // Rule 3: Destructive command check
    this.rules.push({
      id: 'destructive-command',
      description: 'Block dangerous bash commands',
      severity: 'block',
      check: async (context: SafetyContext): Promise<SafetyResult> => {
        if (context.tool !== 'bash') return { passed: true };

        const command = context.args.command || '';
        const isDangerous = this.config.safety.confirmDestructiveCommands.some(
          (pattern) => command.includes(pattern)
        );

        if (isDangerous) {
          return {
            passed: false,
            message: `Potentially destructive command detected: "${command}"`,
            suggestion: `This command has been blocked. Review and run manually if needed.`,
          };
        }
        return { passed: true };
      },
    });

    // Rule 4: Max concurrent sessions
    this.rules.push({
      id: 'max-sessions',
      description: 'Limit concurrent sessions per workspace',
      severity: 'warning',
      check: async (context: SafetyContext): Promise<SafetyResult> => {
        try {
          const redis = getRedisClient();
          const pattern = `workstream:opencode:session:*`;
          const keys = await redis.keys(pattern);
          
          let count = 0;
          for (const key of keys) {
            const sessionData = await redis.get(key);
            if (sessionData) {
              const session = JSON.parse(sessionData);
              if (session.workspacePath === context.workspacePath && session.status === 'active') {
                count++;
              }
            }
          }

          if (count >= this.config.safety.maxConcurrentSessions) {
            return {
              passed: false,
              message: `Too many concurrent sessions (${count}) in this workspace`,
              suggestion: `Close idle sessions to improve performance`,
            };
          }
        } catch (error) {
          // Silent fail
        }
        return { passed: true };
      },
    });
  }

  /**
   * Check all safety rules
   */
  async checkSafety(context: SafetyContext): Promise<{
    allowed: boolean;
    warnings: string[];
    blocked: string[];
  }> {
    const warnings: string[] = [];
    const blocked: string[] = [];

    for (const rule of this.rules) {
      const result = await rule.check(context);
      
      if (!result.passed) {
        const message = `${result.message}${result.suggestion ? ` ${result.suggestion}` : ''}`;
        
        if (rule.severity === 'block') {
          blocked.push(message);
          
          // Publish safety event
          await publishEvent('opencode_safety_blocked', context.workspacePath, {
            rule: rule.id,
            tool: context.tool,
            message: result.message,
          });
          
          // Send notification
          await publishNotification(
            'OpenCode Safety',
            `⛔ ${result.message}`,
            'opencode_safety_blocked',
            'failure',
            context.workspacePath
          );
        } else if (rule.severity === 'warning') {
          warnings.push(message);
          
          await publishEvent('opencode_safety_warning', context.workspacePath, {
            rule: rule.id,
            tool: context.tool,
            message: result.message,
          });
        }
      }
    }

    return {
      allowed: blocked.length === 0,
      warnings,
      blocked,
    };
  }
}
