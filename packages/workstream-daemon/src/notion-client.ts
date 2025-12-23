import { Client } from '@notionhq/client';
import type { NotionTask, NotionConfig, NotionPropertyMapping } from './notion-types.js';

let notionClient: Client | null = null;

/**
 * Get Notion configuration from environment variables
 */
export function getNotionConfig(): NotionConfig | null {
  const apiKey = process.env.NOTION_API_KEY;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!apiKey || !databaseId) {
    return null;
  }

  return {
    apiKey,
    databaseId,
    propertyMapping: {
      idProperty: process.env.NOTION_ID_PROPERTY || 'ID',
      branchProperty: process.env.NOTION_BRANCH_PROPERTY || 'Branch name',
      statusProperty: process.env.NOTION_STATUS_PROPERTY || 'Status',
    },
  };
}

/**
 * Check if Notion is configured
 */
export function isNotionConfigured(): boolean {
  return getNotionConfig() !== null;
}

/**
 * Initialize or get the Notion client
 */
function getNotionClient(apiKey: string): Client {
  if (!notionClient) {
    notionClient = new Client({ auth: apiKey });
  }
  return notionClient;
}

/**
 * Fetch tasks from Notion database filtered by status groups
 */
export async function fetchNotionTasks(): Promise<NotionTask[]> {
  const config = getNotionConfig();
  if (!config) {
    console.log('[Notion] Not configured - missing NOTION_API_KEY or NOTION_DATABASE_ID');
    return [];
  }

  const client = getNotionClient(config.apiKey);
  const { propertyMapping, databaseId } = config;

  try {
    console.log(`[Notion] Fetching tasks from database ${databaseId}...`);

    // Query the database - we'll filter client-side for status groups
    const response = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
    });

    const tasks: NotionTask[] = [];

    for (const page of response.results) {
      if (page.object !== 'page' || !('properties' in page)) continue;

      const task = parseNotionPage(page, propertyMapping);

      // Only include to_do and in_progress tasks
      if (task && (task.statusGroup === 'to_do' || task.statusGroup === 'in_progress')) {
        tasks.push(task);
      }
    }

    console.log(`[Notion] Found ${tasks.length} active tasks`);
    return tasks;
  } catch (error) {
    console.error('[Notion] Failed to fetch tasks:', error);
    return [];
  }
}

/**
 * Parse a Notion page into a NotionTask
 */
function parseNotionPage(
  page: any,
  propertyMapping: NotionPropertyMapping
): NotionTask | null {
  try {
    const properties = page.properties;

    // Extract title (find the title property)
    let title = '';
    for (const [, value] of Object.entries(properties)) {
      if ((value as any).type === 'title') {
        const titleArray = (value as any).title;
        title = titleArray.map((t: any) => t.plain_text).join('');
        break;
      }
    }

    // Extract task ID
    const idProp = properties[propertyMapping.idProperty];
    let taskId = '';
    if (idProp) {
      if (idProp.type === 'unique_id') {
        const prefix = idProp.unique_id?.prefix || '';
        const number = idProp.unique_id?.number || '';
        taskId = prefix ? `${prefix}-${number}` : String(number);
      } else if (idProp.type === 'number') {
        taskId = String(idProp.number || '');
      } else if (idProp.type === 'rich_text') {
        taskId = idProp.rich_text.map((t: any) => t.plain_text).join('');
      }
    }

    // Extract branch name from property
    const branchProp = properties[propertyMapping.branchProperty];
    let branchNameSuffix = '';
    if (branchProp) {
      if (branchProp.type === 'rich_text') {
        branchNameSuffix = branchProp.rich_text.map((t: any) => t.plain_text).join('');
      } else if (branchProp.type === 'title') {
        branchNameSuffix = branchProp.title.map((t: any) => t.plain_text).join('');
      } else if (branchProp.type === 'formula' && branchProp.formula?.type === 'string') {
        branchNameSuffix = branchProp.formula.string || '';
      }
    }

    // Extract status
    const statusProp = properties[propertyMapping.statusProperty];
    let status = '';
    let statusGroup: 'to_do' | 'in_progress' | 'complete' | 'unknown' = 'unknown';

    if (statusProp && statusProp.type === 'status') {
      status = statusProp.status?.name || '';

      // Notion status has groups, but we need to infer from status configuration
      // The Notion API doesn't directly expose the group in the page response
      // We'll infer from common status names
      const lowerStatus = status.toLowerCase();
      if (
        lowerStatus.includes('done') ||
        lowerStatus.includes('complete') ||
        lowerStatus.includes('won\'t fix') ||
        lowerStatus.includes('out of scope')
      ) {
        statusGroup = 'complete';
      } else if (
        lowerStatus.includes('progress') ||
        lowerStatus.includes('working') ||
        lowerStatus.includes('testing') ||
        lowerStatus.includes('refining') ||
        lowerStatus.includes('waiting')
      ) {
        statusGroup = 'in_progress';
      } else if (
        lowerStatus.includes('not started') ||
        lowerStatus.includes('to do') ||
        lowerStatus.includes('todo') ||
        lowerStatus.includes('backlog') ||
        lowerStatus.includes('check') ||
        lowerStatus.includes('propose')
      ) {
        statusGroup = 'to_do';
      }
    }

    // Generate branch name: {taskId}-{branchSuffix}
    const branchName = generateBranchName(taskId, branchNameSuffix, title);

    // Construct URL
    const url = `https://notion.so/${page.id.replace(/-/g, '')}`;

    return {
      id: page.id,
      taskId,
      title,
      branchName,
      status,
      statusGroup,
      url,
    };
  } catch (error) {
    console.error('[Notion] Failed to parse page:', error);
    return null;
  }
}

/**
 * Generate a git branch name from task properties
 * Format: {taskId}-{branchName} (e.g., "DEV-42-fix-login-bug")
 */
function generateBranchName(taskId: string, branchSuffix: string, title: string): string {
  const parts: string[] = [];

  // Add task ID if present
  if (taskId) {
    parts.push(taskId);
  }

  // Prefer explicit branch suffix, fall back to sanitized title
  const suffixToUse = branchSuffix || title;

  if (suffixToUse) {
    // Sanitize: lowercase, replace spaces with hyphens, remove special chars
    const sanitized = suffixToUse
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50); // Limit length

    if (sanitized) {
      parts.push(sanitized);
    }
  }

  return parts.join('-') || 'unnamed-task';
}

/**
 * Update a Notion task's status to "In Progress"
 * Returns true if successful, false otherwise
 */
export async function updateNotionTaskStatus(
  pageId: string,
  statusName: string = 'In Progress'
): Promise<{ success: boolean; error?: string }> {
  const config = getNotionConfig();
  if (!config) {
    return { success: false, error: 'Notion not configured' };
  }

  const client = getNotionClient(config.apiKey);
  const { propertyMapping } = config;

  try {
    console.log(`[Notion] Updating task ${pageId} status to "${statusName}"...`);

    await client.pages.update({
      page_id: pageId,
      properties: {
        [propertyMapping.statusProperty]: {
          status: {
            name: statusName,
          },
        },
      },
    });

    console.log(`[Notion] Task ${pageId} status updated to "${statusName}"`);
    return { success: true };
  } catch (error) {
    console.error('[Notion] Failed to update task status:', error);
    return { success: false, error: String(error) };
  }
}
