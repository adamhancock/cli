import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { NotionTrackerPage } from "./pages/notion-tracker";
import { SessionsPage } from "./pages/sessions";
import { LogsPage } from "./pages/logs";
import { PRsPage } from "./pages/prs";
import { FeedPage } from "./pages/feed";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<NotionTrackerPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="prs" element={<PRsPage />} />
          <Route path="feed" element={<FeedPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
