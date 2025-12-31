/**
 * Notion task as parsed from the database
 */
export interface NotionTask {
  id: string;                    // Notion page ID
  taskId: string;                // User-defined ID (e.g., "DEV-42")
  title: string;                 // Task summary/title
  branchName: string;            // Generated branch name (e.g., "DEV-42-fix-login-bug")
  status: string;                // Current status text
  statusGroup: 'to_do' | 'in_progress' | 'complete' | 'unknown';
  type?: string;                 // Task type (Bug, Feature, Check, etc.)
  url: string;                   // Notion page URL
  contentMarkdown?: string;      // Full page content as markdown
}

/**
 * Configuration for Notion property mapping
 */
export interface NotionPropertyMapping {
  idProperty: string;            // Property name for task ID
  branchProperty: string;        // Property name for branch name
  statusProperty: string;        // Property name for status (default: "Status")
  typeProperty: string;          // Property name for task type (default: "Task type")
}

/**
 * Environment-based Notion configuration
 */
export interface NotionConfig {
  apiKey: string;
  databaseId: string;
  propertyMapping: NotionPropertyMapping;
  excludeStatuses: string[];  // Status names to filter out (e.g., "Done", "Won't fix")
}
