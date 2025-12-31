import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Download, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { TaskDetails } from "@/components/tasks/TaskDetails";
import { CreateTaskDialog } from "@/components/tasks/CreateTaskDialog";
import { NotionImportDialog } from "@/components/tasks/NotionImportDialog";
import { useTaskStore } from "@/stores/taskStore";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { selectedTaskId, selectTask, getTaskById } = useTaskStore();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [isImportOpen, setIsImportOpen] = React.useState(false);

  const selectedTask = selectedTaskId ? getTaskById(selectedTaskId) : null;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b bg-card">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Workstream Kanban</h1>
          <span className="text-sm text-muted-foreground">
            AI-Powered Task Management
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <Download className="h-4 w-4 mr-2" />
            Import from Notion
          </Button>
          <Button onClick={() => setIsCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Task
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Kanban Board */}
        <main className="flex-1 overflow-hidden">
          <KanbanBoard />
        </main>

        {/* Task Details Panel */}
        {selectedTask && (
          <aside className="w-96 shrink-0">
            <TaskDetails
              task={selectedTask}
              onClose={() => selectTask(null)}
            />
          </aside>
        )}
      </div>

      {/* Dialogs */}
      <CreateTaskDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />
      <NotionImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  );
}
