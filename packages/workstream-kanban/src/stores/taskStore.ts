import { create } from "zustand";
import type { Task, TaskStatus, KanbanColumn } from "@/types";
import { STATUS_CONFIG } from "@/types";
import { taskApi } from "@/lib/api";

interface TaskStore {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  selectedTaskId: string | null;

  // Actions
  fetchTasks: () => Promise<void>;
  addTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt" | "order">) => Promise<Task>;
  updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (id: string, status: TaskStatus, order: number) => Promise<void>;
  selectTask: (id: string | null) => void;

  // Derived
  getColumns: () => KanbanColumn[];
  getTaskById: (id: string) => Task | undefined;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  isLoading: false,
  error: null,
  selectedTaskId: null,

  fetchTasks: async () => {
    set({ isLoading: true, error: null });
    try {
      const tasks = await taskApi.list();
      set({ tasks, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  addTask: async (taskInput) => {
    try {
      const task = await taskApi.create(taskInput);
      set((state) => ({ tasks: [...state.tasks, task] }));
      return task;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateTask: async (id, updates) => {
    try {
      const task = await taskApi.update(id, updates);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? task : t)),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteTask: async (id) => {
    try {
      await taskApi.delete(id);
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== id),
        selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  moveTask: async (id, status, order) => {
    // Optimistic update
    const originalTasks = get().tasks;
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, status, order } : t
      ),
    }));

    try {
      await taskApi.move(id, status, order);
    } catch (error) {
      // Rollback on error
      set({ tasks: originalTasks, error: String(error) });
      throw error;
    }
  },

  selectTask: (id) => {
    set({ selectedTaskId: id });
  },

  getColumns: () => {
    const { tasks } = get();
    const statuses: TaskStatus[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
    ];

    return statuses.map((status) => ({
      id: status,
      title: STATUS_CONFIG[status].title,
      color: STATUS_CONFIG[status].color,
      tasks: tasks
        .filter((t) => t.status === status)
        .sort((a, b) => a.order - b.order),
    }));
  },

  getTaskById: (id) => {
    return get().tasks.find((t) => t.id === id);
  },
}));
