import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
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

  // Comma-separated list of statuses to exclude (completed tasks)
  const excludeStatuses = process.env.NOTION_EXCLUDE_STATUSES
    ? process.env.NOTION_EXCLUDE_STATUSES.split(',').map(s => s.trim())
    : ['Done', "Won't fix", 'Out of scope'];

  return {
    apiKey,
    databaseId,
    propertyMapping: {
      idProperty: process.env.NOTION_ID_PROPERTY || 'ID',
      branchProperty: process.env.NOTION_BRANCH_PROPERTY || 'Branch name',
      statusProperty: process.env.NOTION_STATUS_PROPERTY || 'Status',
      typeProperty: process.env.NOTION_TYPE_PROPERTY || 'Task type',
    },
    excludeStatuses,
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
  const markdownConverter = new NotionToMarkdown({ notionClient: client });
  const { propertyMapping, databaseId, excludeStatuses } = config;

  try {
    console.log(`[Notion] Fetching tasks from database ${databaseId}...`);
    console.log(`[Notion] Excluding statuses: ${excludeStatuses.join(', ')}`);

    // Build filter to exclude completed statuses at API level (faster than client-side filtering)
    const statusFilters = excludeStatuses.map(status => ({
      property: propertyMapping.statusProperty,
      status: {
        does_not_equal: status,
      },
    }));

    // Query the database with API-level filter
    const response = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
      filter: statusFilters.length > 0 ? { and: statusFilters } : undefined,
    });

    const tasks: NotionTask[] = [];

    for (const page of response.results) {
      if (page.object !== 'page' || !('properties' in page)) continue;

      const task = parseNotionPage(page, propertyMapping);

      // Double-check status group (in case of other completion statuses)
      if (task && task.statusGroup !== 'complete') {
        task.contentMarkdown = await convertPageToMarkdown(task.id, markdownConverter);
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

    // Extract task type
    const typeProp = properties[propertyMapping.typeProperty];
    let type: string | undefined;
    if (typeProp) {
      if (typeProp.type === 'select') {
        type = typeProp.select?.name;
      } else if (typeProp.type === 'multi_select') {
        type = typeProp.multi_select?.[0]?.name;
      } else if (typeProp.type === 'rich_text') {
        type = typeProp.rich_text.map((t: any) => t.plain_text).join('');
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
      type,
      url,
    };
  } catch (error) {
    console.error('[Notion] Failed to parse page:', error);
    return null;
  }
}

/**
 * Convert a Notion page to markdown, returning a helpful fallback on failure
 */
async function convertPageToMarkdown(
  pageId: string,
  converter: NotionToMarkdown
): Promise<string | undefined> {
  try {
    const mdBlocks = await converter.pageToMarkdown(pageId);
    const result = converter.toMarkdownString(mdBlocks);
    const markdown = result.parent?.trim() || '';
    return markdown || '_No additional details were provided in Notion._';
  } catch (error) {
    console.error(`[Notion] Failed to convert page ${pageId} to markdown:`, error);
    return '_Unable to load Notion content. Please open the task in Notion._';
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

/**
 * Create a new task in the Notion database
 * Returns the created task if successful
 */
export async function createNotionTask(
  title: string
): Promise<{ success: boolean; task?: NotionTask; error?: string }> {
  const config = getNotionConfig();
  if (!config) {
    return { success: false, error: 'Notion not configured' };
  }

  if (!title || !title.trim()) {
    return { success: false, error: 'Title is required' };
  }

  const client = getNotionClient(config.apiKey);
  const markdownConverter = new NotionToMarkdown({ notionClient: client });
  const { propertyMapping, databaseId } = config;

  try {
    console.log(`[Notion] Creating task: "${title}"...`);

    // First, we need to find the title property name by querying the database schema
    const database = await client.databases.retrieve({ database_id: databaseId });
    let titlePropertyName = 'Name'; // Default fallback

    // Find the title property
    for (const [propName, propValue] of Object.entries(database.properties)) {
      if ((propValue as any).type === 'title') {
        titlePropertyName = propName;
        break;
      }
    }

    // Create the page with title and initial status "Not started"
    const response = await client.pages.create({
      parent: { database_id: databaseId },
      properties: {
        [titlePropertyName]: {
          title: [{ text: { content: title.trim() } }],
        },
        [propertyMapping.statusProperty]: {
          status: { name: 'Not started' },
        },
      },
    });

    // Parse the created page
    const task = parseNotionPage(response, propertyMapping);

    if (task) {
      // Fetch markdown content for the new task
      task.contentMarkdown = await convertPageToMarkdown(task.id, markdownConverter);
      console.log(`[Notion] Task created: ${task.taskId || task.id} - ${task.title}`);
      return { success: true, task };
    }

    return { success: false, error: 'Failed to parse created task' };
  } catch (error) {
    console.error('[Notion] Failed to create task:', error);
    return { success: false, error: String(error) };
  }
}

