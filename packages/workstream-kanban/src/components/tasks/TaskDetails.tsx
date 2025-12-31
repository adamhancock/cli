import * as React from "react";
import {
  X,
  Play,
  Bot,
  ExternalLink,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  GitBranch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTaskStore } from "@/stores/taskStore";
import { agentApi } from "@/lib/api";
import { STATUS_CONFIG, type Task } from "@/types";

interface TaskDetailsProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetails({ task, onClose }: TaskDetailsProps) {
  const { updateTask, deleteTask } = useTaskStore();
  const [isEditing, setIsEditing] = React.useState(false);
  const [title, setTitle] = React.useState(task.title);
  const [description, setDescription] = React.useState(task.description || "");
  const [workingDirectory, setWorkingDirectory] = React.useState("");
  const [isStartingAgent, setIsStartingAgent] = React.useState(false);

  const handleSave = async () => {
    await updateTask(task.id, {
      title,
      description: description || undefined,
    });
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this task?")) {
      await deleteTask(task.id);
      onClose();
    }
  };

  const handleStartClaude = async () => {
    if (!workingDirectory) {
      alert("Please enter a working directory");
      return;
    }

    setIsStartingAgent(true);
    try {
      await agentApi.startClaude({
        taskId: task.id,
        workingDirectory,
        prompt: task.description,
      });
    } catch (error) {
      console.error("Failed to start Claude:", error);
      alert("Failed to start Claude Code");
    } finally {
      setIsStartingAgent(false);
    }
  };

  const handleStartCodexReview = async () => {
    if (!workingDirectory) {
      alert("Please enter a working directory");
      return;
    }

    setIsStartingAgent(true);
    try {
      await agentApi.startCodexReview({
        taskId: task.id,
        workingDirectory,
        branchName: task.branchName,
      });
    } catch (error) {
      console.error("Failed to start Codex review:", error);
      alert("Failed to start Codex review");
    } finally {
      setIsStartingAgent(false);
    }
  };

  const statusConfig = STATUS_CONFIG[task.status];

  return (
    <div className="h-full flex flex-col bg-background border-l">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: statusConfig.color }}
          />
          <Badge variant="outline">{statusConfig.title}</Badge>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Title & Description */}
        <div className="space-y-4">
          {isEditing ? (
            <>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="font-semibold text-lg"
              />
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add description..."
                rows={4}
              />
              <div className="flex gap-2">
                <Button onClick={handleSave}>Save</Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setTitle(task.title);
                    setDescription(task.description || "");
                    setIsEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2
                className="font-semibold text-lg cursor-pointer hover:text-primary"
                onClick={() => setIsEditing(true)}
              >
                {task.title}
              </h2>
              <p
                className={cn(
                  "text-sm cursor-pointer hover:text-primary",
                  !task.description && "text-muted-foreground italic"
                )}
                onClick={() => setIsEditing(true)}
              >
                {task.description || "Click to add description..."}
              </p>
            </>
          )}
        </div>

        {/* Agent Status */}
        {task.agentStatus && (
          <div className="p-4 bg-muted rounded-lg space-y-2">
            <div className="flex items-center gap-2">
              {task.agentStatus === "running" && (
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              )}
              {task.agentStatus === "completed" && (
                <CheckCircle className="h-4 w-4 text-green-500" />
              )}
              {task.agentStatus === "failed" && (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              <span className="font-medium capitalize">
                {task.assignedAgent} - {task.agentStatus}
              </span>
            </div>
          </div>
        )}

        {/* Agent Controls */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-muted-foreground">
            Agent Controls
          </h3>
          <div className="space-y-2">
            <Input
              placeholder="Working directory (e.g., /path/to/project)"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                onClick={handleStartClaude}
                disabled={isStartingAgent || task.agentStatus === "running"}
                className="flex-1"
              >
                <Play className="h-4 w-4 mr-2" />
                Start Claude
              </Button>
              <Button
                variant="outline"
                onClick={handleStartCodexReview}
                disabled={isStartingAgent || task.agentStatus === "running"}
                className="flex-1"
              >
                <Bot className="h-4 w-4 mr-2" />
                Codex Review
              </Button>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-muted-foreground">Details</h3>
          <div className="space-y-2 text-sm">
            {task.branchName && (
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <code className="bg-muted px-2 py-0.5 rounded">
                  {task.branchName}
                </code>
              </div>
            )}
            {task.notionUrl && (
              <a
                href={task.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-primary hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                Open in Notion
              </a>
            )}
            <div className="text-muted-foreground">
              Created: {new Date(task.createdAt).toLocaleString()}
            </div>
            <div className="text-muted-foreground">
              Updated: {new Date(task.updatedAt).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t">
        <Button
          variant="destructive"
          className="w-full"
          onClick={handleDelete}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Task
        </Button>
      </div>
    </div>
  );
}
