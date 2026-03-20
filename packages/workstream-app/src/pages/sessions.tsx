import { Monitor } from "lucide-react";

export function SessionsPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
      <Monitor className="h-12 w-12" />
      <h2 className="text-2xl font-semibold text-foreground">Sessions</h2>
      <p className="text-sm">View and manage active sessions.</p>
    </div>
  );
}
