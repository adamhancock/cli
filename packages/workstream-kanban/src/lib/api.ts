import type { Task, CreateTaskInput, UpdateTaskInput, TaskStatus, AgentSession } from "@/types";

const API_BASE = "/api";

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// Task API
export const taskApi = {
  list: () => fetchApi<Task[]>("/tasks"),

  get: (id: string) => fetchApi<Task>(`/tasks/${id}`),

  create: (input: CreateTaskInput) =>
    fetchApi<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  update: (id: string, input: UpdateTaskInput) =>
    fetchApi<Task>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    fetchApi<void>(`/tasks/${id}`, {
      method: "DELETE",
    }),

  move: (id: string, status: TaskStatus, order: number) =>
    fetchApi<Task>(`/tasks/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ status, order }),
    }),
};

// Notion API
export const notionApi = {
  import: (config: {
    apiKey: string;
    databaseId: string;
    statusProperty?: string;
    statusMapping?: Record<string, TaskStatus>;
  }) =>
    fetchApi<{ imported: number; tasks: Task[] }>("/notion/import", {
      method: "POST",
      body: JSON.stringify(config),
    }),
};

// Agent API
export const agentApi = {
  startClaude: (params: {
    taskId: string;
    workingDirectory: string;
    prompt?: string;
  }) =>
    fetchApi<AgentSession>("/agents/claude/start", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  startCodexReview: (params: {
    taskId: string;
    workingDirectory: string;
    branchName?: string;
  }) =>
    fetchApi<AgentSession>("/agents/codex/review", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getSession: (id: string) => fetchApi<AgentSession>(`/agents/sessions/${id}`),

  listSessions: () => fetchApi<AgentSession[]>("/agents/sessions"),
};
