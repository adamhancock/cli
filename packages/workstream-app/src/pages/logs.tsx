import { ScrollText } from "lucide-react";

export function LogsPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
      <ScrollText className="h-12 w-12" />
      <h2 className="text-2xl font-semibold text-foreground">Logs</h2>
      <p className="text-sm">View real-time logs from the daemon.</p>
    </div>
  );
}
