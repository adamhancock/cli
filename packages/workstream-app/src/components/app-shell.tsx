import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { useSocket } from "@/hooks/use-socket";

export function AppShell() {
  const { connected } = useSocket();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar connected={connected} />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
