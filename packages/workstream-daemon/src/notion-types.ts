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
  url: string;                   // Notion page URL
}

/**
 * Configuration for Notion property mapping
 */
export interface NotionPropertyMapping {
  idProperty: string;            // Property name for task ID
  branchProperty: string;        // Property name for branch name
  statusProperty: string;        // Property name for status (default: "Status")
}

/**
 * Environment-based Notion configuration
 */
export interface NotionConfig {
  apiKey: string;
  databaseId: string;
  propertyMapping: NotionPropertyMapping;
}
