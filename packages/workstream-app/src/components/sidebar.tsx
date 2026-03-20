import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Monitor,
  ScrollText,
  GitPullRequest,
  Rss,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Notion Tracker", icon: LayoutDashboard },
  { to: "/sessions", label: "Sessions", icon: Monitor },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/feed", label: "Feed", icon: Rss },
];

interface SidebarProps {
  connected: boolean;
}

export function Sidebar({ connected }: SidebarProps) {
  return (
    <aside className="flex h-screen w-56 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <h1 className="text-sm font-semibold tracking-tight">Workstream</h1>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connected ? "bg-green-500" : "bg-red-500"
            )}
          />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>
    </aside>
  );
}
