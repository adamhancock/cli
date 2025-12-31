import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Client } from "@notionhq/client";
import {
  AgentSessionSchema,
  AgentStatus,
  AgentType,
  CreateTaskInput,
  TaskSchema,
  TaskStatus,
  UpdateTaskInput,
} from "@/types";

// In-memory store (replace with database in production)
const tasks: Map<string, z.infer<typeof TaskSchema>> = new Map();
const agentSessions: Map<string, z.infer<typeof AgentSessionSchema>> =
  new Map();

// Helper to generate IDs
const generateId = () => crypto.randomUUID();

// Helper to get current timestamp
const now = () => new Date().toISOString();

// Create OpenAPI Hono app
const app = new OpenAPIHono().basePath("/api");

// Error schema
const ErrorSchema = z.object({
  error: z.string(),
});

// ============ TASK ROUTES ============

// List all tasks
const listTasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Tasks"],
  summary: "List all tasks",
  responses: {
    200: {
      description: "List of tasks",
      content: {
        "application/json": {
          schema: z.array(TaskSchema),
        },
      },
    },
  },
});

app.openapi(listTasksRoute, (c) => {
  const allTasks = Array.from(tasks.values()).sort((a, b) => a.order - b.order);
  return c.json(allTasks);
});

// Get task by ID
const getTaskRoute = createRoute({
  method: "get",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Get task by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Task found",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(getTaskRoute, (c) => {
  const { id } = c.req.valid("param");
  const task = tasks.get(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  return c.json(task);
});

// Create task
const createTaskRoute = createRoute({
  method: "post",
  path: "/tasks",
  tags: ["Tasks"],
  summary: "Create a new task",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateTaskInput,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Task created",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
  },
});

app.openapi(createTaskRoute, (c) => {
  const input = c.req.valid("json");
  const id = generateId();
  const maxOrder = Math.max(0, ...Array.from(tasks.values()).map((t) => t.order));
  const task: z.infer<typeof TaskSchema> = {
    ...input,
    id,
    priority: input.priority ?? 3,
    createdAt: now(),
    updatedAt: now(),
    order: maxOrder + 1,
  };
  tasks.set(id, task);
  return c.json(task, 201);
});

// Update task
const updateTaskRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Update a task",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: UpdateTaskInput,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Task updated",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(updateTaskRoute, (c) => {
  const { id } = c.req.valid("param");
  const input = c.req.valid("json");
  const task = tasks.get(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const updated = {
    ...task,
    ...input,
    updatedAt: now(),
  };
  tasks.set(id, updated);
  return c.json(updated);
});

// Delete task
const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Delete a task",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: {
      description: "Task deleted",
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(deleteTaskRoute, (c) => {
  const { id } = c.req.valid("param");
  if (!tasks.has(id)) {
    return c.json({ error: "Task not found" }, 404);
  }
  tasks.delete(id);
  return c.body(null, 204);
});

// Move task (update status and order)
const moveTaskRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/move",
  tags: ["Tasks"],
  summary: "Move task to new status/position",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: TaskStatus,
            order: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Task moved",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(moveTaskRoute, (c) => {
  const { id } = c.req.valid("param");
  const { status, order } = c.req.valid("json");
  const task = tasks.get(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const updated = {
    ...task,
    status,
    order,
    updatedAt: now(),
  };
  tasks.set(id, updated);
  return c.json(updated);
});

// ============ NOTION ROUTES ============

const importNotionRoute = createRoute({
  method: "post",
  path: "/notion/import",
  tags: ["Notion"],
  summary: "Import tasks from Notion database",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            apiKey: z.string(),
            databaseId: z.string(),
            statusProperty: z.string().default("Status"),
            statusMapping: z
              .record(z.string(), TaskStatus)
              .optional()
              .default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tasks imported",
      content: {
        "application/json": {
          schema: z.object({
            imported: z.number(),
            tasks: z.array(TaskSchema),
          }),
        },
      },
    },
    400: {
      description: "Import failed",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(importNotionRoute, async (c) => {
  const { apiKey, databaseId, statusProperty, statusMapping } =
    c.req.valid("json");

  try {
    const notion = new Client({ auth: apiKey });
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
    });

    const importedTasks: z.infer<typeof TaskSchema>[] = [];
    let maxOrder = Math.max(
      0,
      ...Array.from(tasks.values()).map((t) => t.order)
    );

    for (const page of response.results) {
      if (page.object !== "page" || !("properties" in page)) continue;

      const properties = page.properties;

      // Extract title
      let title = "";
      for (const [, value] of Object.entries(properties)) {
        if ((value as any).type === "title") {
          const titleArray = (value as any).title;
          title = titleArray.map((t: any) => t.plain_text).join("");
          break;
        }
      }

      if (!title) continue;

      // Extract status
      const statusProp = properties[statusProperty];
      let notionStatus = "";
      if (statusProp && (statusProp as any).type === "status") {
        notionStatus = (statusProp as any).status?.name || "";
      }

      // Map status
      let status: z.infer<typeof TaskStatus> = "todo";
      if (statusMapping && notionStatus in statusMapping) {
        status = statusMapping[notionStatus];
      } else {
        // Default mapping based on common patterns
        const lower = notionStatus.toLowerCase();
        if (lower.includes("done") || lower.includes("complete")) {
          status = "done";
        } else if (lower.includes("progress") || lower.includes("working")) {
          status = "in_progress";
        } else if (lower.includes("review")) {
          status = "in_review";
        } else if (lower.includes("backlog")) {
          status = "backlog";
        }
      }

      const id = generateId();
      maxOrder++;

      const task: z.infer<typeof TaskSchema> = {
        id,
        title,
        status,
        priority: 3,
        notionId: page.id,
        notionUrl: `https://notion.so/${page.id.replace(/-/g, "")}`,
        createdAt: now(),
        updatedAt: now(),
        order: maxOrder,
      };

      tasks.set(id, task);
      importedTasks.push(task);
    }

    return c.json({
      imported: importedTasks.length,
      tasks: importedTasks,
    });
  } catch (error) {
    return c.json(
      { error: `Failed to import from Notion: ${String(error)}` },
      400
    );
  }
});

// ============ AGENT ROUTES ============

// Start Claude Code agent on a task
const startClaudeRoute = createRoute({
  method: "post",
  path: "/agents/claude/start",
  tags: ["Agents"],
  summary: "Start Claude Code agent on a task",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            taskId: z.string(),
            workingDirectory: z.string(),
            prompt: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Agent started",
      content: {
        "application/json": {
          schema: AgentSessionSchema,
        },
      },
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(startClaudeRoute, async (c) => {
  const { taskId, workingDirectory, prompt } = c.req.valid("json");

  const task = tasks.get(taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const sessionId = generateId();
  const session: z.infer<typeof AgentSessionSchema> = {
    id: sessionId,
    taskId,
    agentType: "claude",
    status: "running",
    startedAt: now(),
    reviewRequested: false,
  };

  agentSessions.set(sessionId, session);

  // Update task with agent info
  tasks.set(taskId, {
    ...task,
    status: "in_progress",
    assignedAgent: "claude",
    agentStatus: "running",
    agentSessionId: sessionId,
    updatedAt: now(),
  });

  // In production, this would spawn the actual Claude Code CLI process
  // For now, we return the session immediately
  // The actual implementation would use child_process.spawn to run:
  // claude --print --output-format stream-json -p "${prompt || task.description}"

  return c.json(session);
});

// Start Codex review on a task
const startCodexReviewRoute = createRoute({
  method: "post",
  path: "/agents/codex/review",
  tags: ["Agents"],
  summary: "Start Codex CLI review on task changes",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            taskId: z.string(),
            workingDirectory: z.string(),
            branchName: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Review started",
      content: {
        "application/json": {
          schema: AgentSessionSchema,
        },
      },
    },
    404: {
      description: "Task not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(startCodexReviewRoute, async (c) => {
  const { taskId, workingDirectory, branchName } = c.req.valid("json");

  const task = tasks.get(taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const sessionId = generateId();
  const session: z.infer<typeof AgentSessionSchema> = {
    id: sessionId,
    taskId,
    agentType: "codex",
    status: "running",
    startedAt: now(),
    reviewRequested: true,
    reviewStatus: "pending",
  };

  agentSessions.set(sessionId, session);

  // Update task
  tasks.set(taskId, {
    ...task,
    status: "in_review",
    agentStatus: "running",
    agentSessionId: sessionId,
    updatedAt: now(),
  });

  // In production, this would run:
  // codex review --diff "$(git diff main...HEAD)"

  return c.json(session);
});

// Get agent session status
const getSessionRoute = createRoute({
  method: "get",
  path: "/agents/sessions/{id}",
  tags: ["Agents"],
  summary: "Get agent session status",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Session found",
      content: {
        "application/json": {
          schema: AgentSessionSchema,
        },
      },
    },
    404: {
      description: "Session not found",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

app.openapi(getSessionRoute, (c) => {
  const { id } = c.req.valid("param");
  const session = agentSessions.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.json(session);
});

// List all sessions
const listSessionsRoute = createRoute({
  method: "get",
  path: "/agents/sessions",
  tags: ["Agents"],
  summary: "List all agent sessions",
  responses: {
    200: {
      description: "List of sessions",
      content: {
        "application/json": {
          schema: z.array(AgentSessionSchema),
        },
      },
    },
  },
});

app.openapi(listSessionsRoute, (c) => {
  const allSessions = Array.from(agentSessions.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  return c.json(allSessions);
});

// ============ OPENAPI DOCS ============

app.doc("/openapi", {
  openapi: "3.0.0",
  info: {
    title: "Workstream Kanban API",
    version: "1.0.0",
    description:
      "API for managing Kanban tasks with Claude Code and Codex integration",
  },
});

app.get("/docs", swaggerUI({ url: "/api/openapi" }));

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

export type App = typeof app;
export default app;
