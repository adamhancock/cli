import { getRedisClient, REDIS_KEYS } from "./redis-client";
import type { KanbanTaskInstance } from "../types";

/**
 * Fetch all kanban tasks from Redis
 */
export async function getKanbanTasks(): Promise<KanbanTaskInstance[]> {
  try {
    const redis = getRedisClient();

    // Get all task IDs from the set
    const taskIds = await redis.smembers(REDIS_KEYS.KANBAN_TASKS);

    if (taskIds.length === 0) {
      return [];
    }

    // Fetch all task data in parallel
    const taskDataPromises = taskIds.map((id) =>
      redis.get(REDIS_KEYS.KANBAN_TASK(id)),
    );
    const taskDataArray = await Promise.all(taskDataPromises);

    // Parse and filter valid tasks
    const tasks: KanbanTaskInstance[] = [];
    for (const taskData of taskDataArray) {
      if (taskData) {
        try {
          const task = JSON.parse(taskData) as KanbanTaskInstance;
          tasks.push(task);
        } catch (e) {
          console.error("[KanbanClient] Failed to parse task:", e);
        }
      }
    }

    // Sort by updatedAt (most recent first)
    tasks.sort((a, b) => {
      const dateA = new Date(a.updatedAt).getTime();
      const dateB = new Date(b.updatedAt).getTime();
      return dateB - dateA;
    });

    return tasks;
  } catch (e) {
    console.error("[KanbanClient] Failed to fetch kanban tasks:", e);
    return [];
  }
}

/**
 * Get a single kanban task by ID
 */
export async function getKanbanTask(
  taskId: string,
): Promise<KanbanTaskInstance | null> {
  try {
    const redis = getRedisClient();
    const taskData = await redis.get(REDIS_KEYS.KANBAN_TASK(taskId));

    if (!taskData) {
      return null;
    }

    return JSON.parse(taskData) as KanbanTaskInstance;
  } catch (e) {
    console.error("[KanbanClient] Failed to fetch kanban task:", e);
    return null;
  }
}

/**
 * Get CI status label for a task
 */
export function getCiStatusLabel(task: KanbanTaskInstance): string | null {
  const checks = task.prStatus?.checks;
  if (!checks) return null;

  if (checks.conclusion === "success") {
    return `${checks.passing} passing`;
  } else if (checks.conclusion === "failure") {
    return `${checks.failing} failing`;
  } else {
    return `${checks.pending} pending`;
  }
}

/**
 * Get CI status color for a task
 */
export function getCiStatusColor(
  task: KanbanTaskInstance,
): "Green" | "Red" | "Yellow" | null {
  const checks = task.prStatus?.checks;
  if (!checks) return null;

  if (checks.conclusion === "success") {
    return "Green";
  } else if (checks.conclusion === "failure") {
    return "Red";
  } else {
    return "Yellow";
  }
}
