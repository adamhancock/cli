import type { TemplateContext, AllocatedPorts } from '../types.js';

/**
 * Interpolate template variables in a string
 *
 * Supports:
 * - {branch} - Current branch name
 * - {baseDomain} - Base domain from config
 * - {queuePrefix} - Queue prefix derived from branch
 * - {databaseUrl} - Full database connection URL
 * - {ports.appName} - Port for specific app (e.g., {ports.api})
 *
 * @param template - String containing template variables
 * @param context - Context object with variable values
 * @returns Interpolated string
 */
export function interpolate(template: string, context: TemplateContext): string {
  let result = template;

  // Replace simple variables
  result = result.replace(/\{branch\}/g, context.branch);
  result = result.replace(/\{baseDomain\}/g, context.baseDomain);
  result = result.replace(/\{queuePrefix\}/g, context.queuePrefix);
  result = result.replace(/\{databaseUrl\}/g, context.databaseUrl);

  // Replace port variables (e.g., {ports.api})
  result = result.replace(/\{ports\.(\w+)\}/g, (match, appName) => {
    if (context.ports[appName] !== undefined) {
      return String(context.ports[appName]);
    }
    // Return original if port not found
    return match;
  });

  return result;
}

/**
 * Convert branch name to safe identifier
 * - Replaces slashes with underscores
 * - Replaces hyphens with underscores
 * - Converts to lowercase
 *
 * @param branch - Git branch name
 * @returns Safe identifier for database names, queue prefixes, etc.
 */
export function branchToSafeId(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/-/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Convert branch name to URL-safe slug
 * - Replaces slashes with hyphens
 * - Replaces underscores with hyphens
 * - Converts to lowercase
 *
 * @param branch - Git branch name
 * @returns URL-safe slug for subdomains
 */
export function branchToSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Build a database URL from components
 *
 * @param host - Database host
 * @param port - Database port
 * @param user - Database user
 * @param password - Database password
 * @param dbName - Database name
 * @returns PostgreSQL connection URL
 */
export function buildDatabaseUrl(
  host: string,
  port: number,
  user: string,
  password: string,
  dbName: string
): string {
  return `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
}

/**
 * Create a template context from setup data
 *
 * @param branch - Current branch name
 * @param baseDomain - Base domain from config
 * @param databasePrefix - Database prefix from config
 * @param database - Database config
 * @param ports - Allocated ports
 * @returns Template context for interpolation
 */
export function createTemplateContext(
  branch: string,
  baseDomain: string,
  databasePrefix: string,
  database: { host: string; port: number; user: string; password: string },
  ports: AllocatedPorts
): TemplateContext {
  const safeId = branchToSafeId(branch);
  const dbName = `${databasePrefix}_${safeId}`;

  return {
    branch: branchToSlug(branch),
    baseDomain,
    queuePrefix: safeId,
    databaseUrl: buildDatabaseUrl(
      database.host,
      database.port,
      database.user,
      database.password,
      dbName
    ),
    ports
  };
}
