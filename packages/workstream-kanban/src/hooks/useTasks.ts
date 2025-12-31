import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { taskApi, agentApi, notionApi } from "@/lib/api";
import type { Task, CreateTaskInput, UpdateTaskInput, TaskStatus } from "@/types";

// Query keys
export const taskKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...taskKeys.lists(), filters] as const,
  details: () => [...taskKeys.all, "detail"] as const,
  detail: (id: string) => [...taskKeys.details(), id] as const,
};

export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  detail: (id: string) => [...sessionKeys.all, "detail", id] as const,
};

// Hooks
export function useTasks() {
  return useQuery({
    queryKey: taskKeys.lists(),
    queryFn: taskApi.list,
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: taskKeys.detail(id),
    queryFn: () => taskApi.get(id),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: taskApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTaskInput & { id: string }) =>
      taskApi.update(id, input),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      queryClient.setQueryData(taskKeys.detail(data.id), data);
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: taskApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}

export function useMoveTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      status,
      order,
    }: {
      id: string;
      status: TaskStatus;
      order: number;
    }) => taskApi.move(id, status, order),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}

export function useImportNotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: notionApi.import,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}

export function useStartClaude() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: agentApi.startClaude,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

export function useStartCodexReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: agentApi.startCodexReview,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

export function useAgentSessions() {
  return useQuery({
    queryKey: sessionKeys.lists(),
    queryFn: agentApi.listSessions,
  });
}

export function useAgentSession(id: string) {
  return useQuery({
    queryKey: sessionKeys.detail(id),
    queryFn: () => agentApi.getSession(id),
    enabled: !!id,
  });
}
