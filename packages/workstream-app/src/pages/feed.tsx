import { Rss } from "lucide-react";

export function FeedPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
      <Rss className="h-12 w-12" />
      <h2 className="text-2xl font-semibold text-foreground">Feed</h2>
      <p className="text-sm">Activity feed and notifications.</p>
    </div>
  );
}
