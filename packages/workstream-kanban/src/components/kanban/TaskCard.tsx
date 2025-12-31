import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  MoreHorizontal,
  Play,
  Eye,
  Trash2,
  ExternalLink,
  Bot,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTaskStore } from "@/stores/taskStore";
import type { Task } from "@/types";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
}

export function TaskCard({ task, isDragging }: TaskCardProps) {
  const { deleteTask, selectTask, selectedTaskId } = useTaskStore();
  const isSelected = selectedTaskId === task.id;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
  };

  const getAgentStatusIcon = () => {
    if (!task.agentStatus) return null;

    switch (task.agentStatus) {
      case "running":
        return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
      case "completed":
        return <CheckCircle className="h-3 w-3 text-green-500" />;
      case "failed":
        return <XCircle className="h-3 w-3 text-red-500" />;
      default:
        return null;
    }
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "cursor-grab active:cursor-grabbing transition-all",
        isDragging && "opacity-50 shadow-lg scale-105",
        isSortableDragging && "opacity-50",
        isSelected && "ring-2 ring-primary"
      )}
      onClick={() => selectTask(task.id)}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          {/* Drag Handle */}
          <button
            className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h4 className="font-medium text-sm leading-tight line-clamp-2">
                {task.title}
              </h4>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => selectTask(task.id)}>
                    <Eye className="h-4 w-4 mr-2" />
                    View Details
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Play className="h-4 w-4 mr-2" />
                    Start Claude
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Bot className="h-4 w-4 mr-2" />
                    Request Codex Review
                  </DropdownMenuItem>
                  {task.notionUrl && (
                    <DropdownMenuItem asChild>
                      <a
                        href={task.notionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open in Notion
                      </a>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={handleDelete}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {task.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {task.description}
              </p>
            )}

            {/* Footer */}
            <div className="flex items-center gap-2 mt-2">
              {task.assignedAgent && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs gap-1">
                      {task.assignedAgent === "claude" ? (
                        <Bot className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                      {task.assignedAgent}
                      {getAgentStatusIcon()}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    {task.assignedAgent === "claude"
                      ? "Claude Code is working on this task"
                      : "Codex is reviewing this task"}
                  </TooltipContent>
                </Tooltip>
              )}

              {task.notionId && (
                <Badge variant="secondary" className="text-xs">
                  Notion
                </Badge>
              )}

              {task.branchName && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs truncate max-w-24">
                      {task.branchName}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{task.branchName}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
