import { LayoutDashboard } from "lucide-react";

export function NotionTrackerPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
      <LayoutDashboard className="h-12 w-12" />
      <h2 className="text-2xl font-semibold text-foreground">Notion Tracker</h2>
      <p className="text-sm">Track and manage Notion tasks.</p>
    </div>
  );
}
