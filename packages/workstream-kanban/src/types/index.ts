import { z } from "zod";

// Task status enum
export const TaskStatus = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// Agent type enum
export const AgentType = z.enum(["claude", "codex"]);
export type AgentType = z.infer<typeof AgentType>;

// Agent status enum
export const AgentStatus = z.enum([
  "idle",
  "running",
  "paused",
  "completed",
  "failed",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

// Task schema
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStatus,
  priority: z.number().min(1).max(5).default(3),
  notionId: z.string().optional(),
  notionUrl: z.string().url().optional(),
  branchName: z.string().optional(),
  assignedAgent: AgentType.optional(),
  agentStatus: AgentStatus.optional(),
  agentSessionId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  order: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

// Create task input
export const CreateTaskInput = TaskSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  order: true,
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

// Update task input
export const UpdateTaskInput = TaskSchema.partial().omit({
  id: true,
  createdAt: true,
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

// Agent session schema
export const AgentSessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentType: AgentType,
  status: AgentStatus,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  reviewRequested: z.boolean().default(false),
  reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

// Notion import config
export const NotionImportConfig = z.object({
  databaseId: z.string(),
  statusMapping: z.record(TaskStatus).optional(),
});
export type NotionImportConfig = z.infer<typeof NotionImportConfig>;

// Kanban column type
export interface KanbanColumn {
  id: TaskStatus;
  title: string;
  color: string;
  tasks: Task[];
}

// Status display config
export const STATUS_CONFIG: Record<
  TaskStatus,
  { title: string; color: string }
> = {
  backlog: { title: "Backlog", color: "#6b7280" },
  todo: { title: "To Do", color: "#3b82f6" },
  in_progress: { title: "In Progress", color: "#f59e0b" },
  in_review: { title: "In Review", color: "#8b5cf6" },
  done: { title: "Done", color: "#10b981" },
};
