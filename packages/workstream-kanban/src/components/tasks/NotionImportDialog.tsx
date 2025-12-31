import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { notionApi } from "@/lib/api";
import { useTaskStore } from "@/stores/taskStore";

interface NotionImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NotionImportDialog({
  open,
  onOpenChange,
}: NotionImportDialogProps) {
  const { fetchTasks } = useTaskStore();
  const [apiKey, setApiKey] = React.useState("");
  const [databaseId, setDatabaseId] = React.useState("");
  const [statusProperty, setStatusProperty] = React.useState("Status");
  const [isLoading, setIsLoading] = React.useState(false);
  const [result, setResult] = React.useState<{
    imported: number;
    error?: string;
  } | null>(null);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || !databaseId.trim()) return;

    setIsLoading(true);
    setResult(null);

    try {
      const response = await notionApi.import({
        apiKey: apiKey.trim(),
        databaseId: databaseId.trim(),
        statusProperty: statusProperty.trim() || "Status",
      });
      setResult({ imported: response.imported });
      await fetchTasks();
    } catch (error) {
      setResult({ imported: 0, error: String(error) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleImport}>
          <DialogHeader>
            <DialogTitle>Import from Notion</DialogTitle>
            <DialogDescription>
              Import tasks from a Notion database into your Kanban board.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <label htmlFor="apiKey" className="text-sm font-medium">
                Notion API Key
              </label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="secret_..."
              />
              <p className="text-xs text-muted-foreground">
                Get your API key from{" "}
                <a
                  href="https://www.notion.so/my-integrations"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Notion Integrations
                </a>
              </p>
            </div>

            <div className="grid gap-2">
              <label htmlFor="databaseId" className="text-sm font-medium">
                Database ID
              </label>
              <Input
                id="databaseId"
                value={databaseId}
                onChange={(e) => setDatabaseId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">
                Find this in your database URL after the workspace name
              </p>
            </div>

            <div className="grid gap-2">
              <label htmlFor="statusProperty" className="text-sm font-medium">
                Status Property Name
              </label>
              <Input
                id="statusProperty"
                value={statusProperty}
                onChange={(e) => setStatusProperty(e.target.value)}
                placeholder="Status"
              />
              <p className="text-xs text-muted-foreground">
                The name of the status property in your Notion database
              </p>
            </div>

            {result && (
              <div
                className={`p-3 rounded-lg text-sm ${
                  result.error
                    ? "bg-destructive/10 text-destructive"
                    : "bg-green-500/10 text-green-700"
                }`}
              >
                {result.error
                  ? `Error: ${result.error}`
                  : `Successfully imported ${result.imported} tasks`}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {result?.imported ? "Done" : "Cancel"}
            </Button>
            <Button
              type="submit"
              disabled={!apiKey.trim() || !databaseId.trim() || isLoading}
            >
              {isLoading ? "Importing..." : "Import Tasks"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
