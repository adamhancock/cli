import { GitPullRequest } from "lucide-react";

export function PRsPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 pt-32 text-muted-foreground">
      <GitPullRequest className="h-12 w-12" />
      <h2 className="text-2xl font-semibold text-foreground">PRs</h2>
      <p className="text-sm">Monitor pull request status and reviews.</p>
    </div>
  );
}
