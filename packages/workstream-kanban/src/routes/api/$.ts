import { createServerFileRoute } from "@tanstack/react-start/server";
import app from "@server/index";

export const ServerRoute = createServerFileRoute("/api/$")
  .methods("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD")
  .handler(async ({ request }) => {
    return app.fetch(request);
  });
