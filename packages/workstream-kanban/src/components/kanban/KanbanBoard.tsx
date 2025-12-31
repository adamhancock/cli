import * as React from "react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useTaskStore } from "@/stores/taskStore";
import { KanbanColumn } from "./KanbanColumn";
import { TaskCard } from "./TaskCard";
import type { Task, TaskStatus } from "@/types";

export function KanbanBoard() {
  const { tasks, moveTask, fetchTasks, getColumns } = useTaskStore();
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const columns = getColumns();

  React.useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    // We can add visual feedback here if needed
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Find the task being dragged
    const activeTask = tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    // Determine the target column
    let targetStatus: TaskStatus;
    let targetOrder: number;

    // Check if dropping on a column
    const targetColumn = columns.find((col) => col.id === overId);
    if (targetColumn) {
      targetStatus = targetColumn.id;
      targetOrder = targetColumn.tasks.length;
    } else {
      // Dropping on another task
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask) return;

      targetStatus = overTask.status;

      // Calculate new order
      const columnTasks = columns
        .find((col) => col.id === targetStatus)
        ?.tasks.filter((t) => t.id !== activeId) || [];

      const overIndex = columnTasks.findIndex((t) => t.id === overId);
      targetOrder = overIndex >= 0 ? overIndex : columnTasks.length;
    }

    // Only update if something changed
    if (activeTask.status !== targetStatus || activeTask.order !== targetOrder) {
      await moveTask(activeId, targetStatus, targetOrder);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 p-4 h-full overflow-x-auto">
        {columns.map((column) => (
          <KanbanColumn key={column.id} column={column} />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? <TaskCard task={activeTask} isDragging /> : null}
      </DragOverlay>
    </DndContext>
  );
}
