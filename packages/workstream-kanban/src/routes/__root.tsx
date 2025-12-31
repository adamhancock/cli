import * as React from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
      <TanStackRouterDevtools position="bottom-right" />
    </TooltipProvider>
  );
}
